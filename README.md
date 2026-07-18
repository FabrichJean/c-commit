# Claude Commit Planner

Un CLI interactif qui génère (et applique, si vous le souhaitez) des plannings de commits Git réalistes — basés sur ce que Claude Code a **réellement** fait pendant vos sessions de chat, pas sur des suppositions.

Le projet contient aussi une application web compagnon indépendante (tableau de bord visuel), décrite en fin de document.

---

## Pour les utilisateurs

### Ce que fait l'outil

1. Vous pointez l'outil vers un dossier de projet.
2. Vous choisissez la base des suggestions :
   - une **session de chat Claude Code précise**,
   - **toutes les sessions** de ce projet (agrégées),
   - ou aucune base réelle (suggestions génériques).
3. L'outil reconstruit l'historique réel des modifications de fichiers (via les sauvegardes de versions de Claude Code, `~/.claude/file-history/`), et découpe ce travail en N commits cohérents et chronologiques — même un seul fichier édité plusieurs fois peut devenir plusieurs commits distincts.
4. Il propose d'**appliquer** ces commits pour de vrai dans votre dépôt Git (avec confirmation explicite), avec les bonnes dates, le bon auteur (votre config Git locale), et — si le dossier n'est pas encore un dépôt — propose de faire `git init` et de configurer un remote (optionnel).

### Prérequis

- **Node.js** v20 ou supérieur (LTS recommandé)
- **npm**
- **Git** (pour les fonctionnalités de scan/application de commits)
- Optionnel : [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) installé globalement, pour une génération de messages de commit par IA en utilisant votre abonnement/config Claude Code existante

### Installation

```bash
npm install
```

### Lancer le CLI

```bash
npm run cli
```

L'outil boucle : à la fin de chaque planning (généré et appliqué ou non), il demande si vous voulez en générer un autre, sans avoir à relancer la commande.

### D'où viennent les messages de commit ?

L'outil essaie, dans cet ordre :

1. **Le CLI Claude Code local** (`claude`), s'il est détecté sur votre `PATH` — utilise votre configuration/abonnement existant, avec streaming en temps réel de la génération.
2. **Une clé API** (`ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` ou `GEMINI_API_KEY`), si définie dans votre environnement ou dans un fichier `.env` local.
3. **Un générateur procédural hors-ligne**, qui fonctionne sans aucune IA — regroupe les changements réels par fichier/étape et rédige des messages de commit basiques mais fondés sur le travail réellement effectué.

Quelle que soit la méthode, l'**auteur** et les **dates** des commits appliqués correspondent toujours à votre configuration Git locale et aux vrais horodatages des changements — jamais des valeurs inventées.

### Configuration des clés API (optionnel)

```bash
cp .env.example .env
```

```env
ANTHROPIC_API_KEY="votre_cle_claude_ici"
# ou, en secours :
GEMINI_API_KEY="votre_cle_gemini_ici"
```

Sans clé et sans CLI Claude Code local détecté, l'outil reste entièrement utilisable grâce au générateur procédural.

### Compiler en exécutable autonome (sans Node.js requis)

Pour distribuer l'outil sans que la personne qui l'utilise ait besoin d'installer Node.js/npm :

```bash
npm run compile
```

Ceci génère 4 exécutables autonomes dans `dist/bin/` :

```
commit-planner-linux-x64
commit-planner-macos-arm64
commit-planner-macos-x64
commit-planner-win-x64.exe
```

Chacun embarque son propre runtime Node.js — aucune installation requise côté utilisateur final. `git` (et `claude`, si vous voulez l'IA locale) doivent toujours être présents sur la machine qui exécute le binaire.

### Installer la commande `cmt`

Pour installer l'exécutable compilé correspondant à votre machine sous la commande `cmt`, directement utilisable depuis n'importe quel dossier :

**macOS / Linux :**
```bash
npm run install:cli
# ou directement :
./install.sh
```

**Windows (PowerShell) :**
```powershell
.\install.ps1
```

Le script détecte automatiquement votre OS/architecture, compile le binaire si besoin (`npm run compile`), puis copie l'exécutable sous le nom `cmt` (`cmt.exe` sur Windows) dans `~/.local/bin` (ou `%LOCALAPPDATA%\cmt` sur Windows). Si ce dossier n'est pas déjà dans votre `PATH`, le script vous indique la ligne à ajouter à votre profil de shell.

Une fois installé :
```bash
cmt
```

Pour changer le dossier d'installation, définissez `CMT_INSTALL_DIR` avant de lancer le script.

### Application web compagnon (optionnelle, indépendante du CLI)

Le dépôt contient aussi un petit tableau de bord web (React + Vite + Express), indépendant du CLI — il ne le lance plus automatiquement et n'en dépend pas.

```bash
npm run dev
```

Puis ouvrez [http://localhost:3000](http://localhost:3000). Pour une build de production :

```bash
npm run build
npm run start
```

---

## Pour les contributeurs

### Structure du projet

```
bin/cli.ts        → le CLI (Claude Commit Planner), point d'entrée principal du projet
bin/diff.d.ts      → déclaration de types locale pour le paquet `diff` (qui n'en fournit pas)
install.sh          → installe le binaire compilé sous la commande `cmt` (macOS/Linux)
install.ps1          → équivalent Windows (PowerShell)
server.ts          → serveur Express de l'application web compagnon
src/               → application web compagnon (React + Vite)
```

### Architecture du CLI (`bin/cli.ts`)

Grandes étapes du pipeline, dans l'ordre où elles apparaissent dans le fichier :

1. **Détection des sessions Claude Code** — `locateClaudeCodeDir()`, `encodeProjectPath()` (reproduit l'encodage utilisé par Claude Code pour `~/.claude/projects/<encodé>`), `findProjectSessions()`, `summarizeSession()`.
2. **Extraction des changements réels** — `extractFileChanges()` parcourt les blocs `tool_use` (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) des transcripts `.jsonl`.
3. **Reconstruction chronologique** — `buildCommitUnits()` lit les sauvegardes de versions de fichiers de Claude Code (`~/.claude/file-history/<session>/<hash>@vN`) pour retrouver l'état réel de chaque fichier à chaque étape. À défaut d'historique, diff contre `HEAD`.
4. **Découpage fin** — `buildMicroSteps()` / `splitContentIntoSteps()` / `expandUnitsToCount()` : diff ligne-à-ligne (paquet `diff`) pour subdiviser une modification en plusieurs commits quand le nombre de "vraies" étapes est insuffisant par rapport au nombre demandé.
5. **Génération des messages** — CLI Claude local en streaming (`runClaudeCliStreaming()`), puis API (Anthropic/Gemini), puis générateur procédural (`generateProceduralCommits*`), dans cet ordre de priorité.
6. **Application réelle** — `applyCommitUnits()` écrit chaque état historique sur disque, commit, puis restaure garantit l'état réel du fichier (`try/finally`), même en cas d'erreur en cours de route.

### Commandes utiles

```bash
npm run cli        # lance le CLI en mode développement (via tsx, pas de build requis)
npm run lint        # tsc --noEmit — à faire passer avant tout commit
npm run build:cli    # bundle bin/cli.ts en un seul fichier CJS (dist/cli.cjs)
npm run compile      # build:cli + génère les 4 exécutables autonomes (voir plus haut)
npm run dev          # lance le serveur de l'app web compagnon
npm run build        # build de production de l'app web compagnon
```

### Conventions

- Le CLI n'utilise **aucun emoji** dans sa sortie terminal — texte + couleur uniquement (thème true-color ancré sur `#285669`, badges `[ CONNECTED ]`/`[ NOT SET ]`). Merci de garder cette cohérence pour tout nouvel écran/message.
- Toute modification touchant à l'application réelle de commits (`applyCommitUnits`, écriture de fichiers, `git commit`) doit rester derrière une confirmation explicite de l'utilisateur — jamais d'action destructive silencieuse.
- Testez les changements avec `npm run lint` puis un passage manuel via `npm run cli` sur un dépôt jetable avant de proposer une modification touchant au flux d'application Git.

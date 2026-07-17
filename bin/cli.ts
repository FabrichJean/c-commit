import { execSync, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as os from 'os';

// ANSI escape codes for stunning styling
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  
  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // High intensity
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  
  // Backgrounds
  bgCyan: '\x1b[46m',
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

// Clear screen and reset cursor position
const clearScreen = () => {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query: string): Promise<string> => {
  return new Promise((resolve) => rl.question(query, resolve));
};

const pressEnterToContinue = async () => {
  process.stdout.write(`\n${C.dim}Press [ENTER] to return to Main Menu...${C.reset}`);
  await question('');
};

// Check if Git is initialized in the given directory
const isGitRepo = (dir: string): boolean => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Read the local (falling back to global) Git author identity, "Name <email>"
const getGitAuthor = (dir: string): string => {
  try {
    const name = execSync('git config user.name', { cwd: dir, stdio: 'pipe' }).toString().trim();
    const email = execSync('git config user.email', { cwd: dir, stdio: 'pipe' }).toString().trim();
    if (name && email) return `${name} <${email}>`;
    if (name) return name;
  } catch {
    // No Git identity configured
  }
  return 'Claude Code <claude@anthropic.com>';
};

// Expand a leading ~ to the user's home directory and resolve to an absolute path
const resolvePath = (input: string): string => {
  let p = input.trim();
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
};

// Search for Claude Code configuration directories
function locateClaudeCodeDir(): string | null {
  const home = os.homedir();
  const potentialPaths = [
    path.join(home, '.claude'),
    path.join(home, '.claude-code'),
    path.join(home, '.config', 'claude-code'),
    path.join(home, 'Library', 'Application Support', 'claude-code'),
    path.join(home, 'AppData', 'Roaming', 'claude-code')
  ];

  for (const p of potentialPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

// Encode an absolute project path the same way Claude Code does for ~/.claude/projects/<encoded>
function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

interface SessionSummary {
  file: string;
  filePath: string;
  mtime: Date;
  messageCount: number;
  title: string;
  firstUserMessage: string;
}

// Extract the text out of a Claude Code message content block array
function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => {
      if (block?.type === 'text') return block.text;
      if (block?.type === 'tool_use') return `[tool: ${block.name}]`;
      if (block?.type === 'tool_result') return `[tool result]`;
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

// Summarize a single .jsonl session transcript file
function summarizeSession(filePath: string): SessionSummary {
  const stats = fs.statSync(filePath);
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  let messageCount = 0;
  let firstUserMessage = '';
  let title = '';

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') {
        messageCount++;
        if (!firstUserMessage && entry.type === 'user') {
          firstUserMessage = extractText(entry.message?.content).slice(0, 60);
        }
      } else if (entry.type === 'ai-title' && entry.aiTitle) {
        title = entry.aiTitle;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { file: path.basename(filePath), filePath, mtime: stats.mtime, messageCount, title, firstUserMessage };
}

// Read the full user/assistant transcript out of a .jsonl session file
function readSessionTranscript(filePath: string): { role: string; text: string; timestamp: string }[] {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  const transcript: { role: string; text: string; timestamp: string }[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') {
        const text = extractText(entry.message?.content);
        if (text) {
          transcript.push({ role: entry.type, text, timestamp: entry.timestamp });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return transcript;
}

// Locate the Claude Code session folder for a given project and summarize its sessions
function findProjectSessions(projDir: string): { claudeHome: string | null; sessionDir: string | null; summaries: SessionSummary[] } {
  const claudeHome = locateClaudeCodeDir();
  if (!claudeHome) return { claudeHome: null, sessionDir: null, summaries: [] };

  const sessionDir = path.join(claudeHome, 'projects', encodeProjectPath(projDir));
  if (!fs.existsSync(sessionDir)) return { claudeHome, sessionDir: null, summaries: [] };

  const sessionFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  const summaries = sessionFiles
    .map(f => summarizeSession(path.join(sessionDir, f)))
    .filter(s => s.messageCount > 0)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return { claudeHome, sessionDir, summaries };
}

interface FileChange {
  file: string;
  tool: string;
  detail: string;
  timestamp: string;
}

// Pull the real file modifications (Edit/Write/MultiEdit/NotebookEdit tool calls) out of one or more sessions
function extractFileChanges(sessionFilePaths: string[]): FileChange[] {
  const changes: FileChange[] = [];

  for (const filePath of sessionFilePaths) {
    let lines: string[];
    try {
      lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    } catch {
      continue;
    }

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block?.type !== 'tool_use') continue;
          const input = block.input || {};

          if (block.name === 'Edit') {
            changes.push({
              file: input.file_path || 'unknown file',
              tool: 'Edit',
              detail: String(input.new_string || '').slice(0, 80).replace(/\n/g, ' '),
              timestamp: entry.timestamp
            });
          } else if (block.name === 'MultiEdit') {
            changes.push({
              file: input.file_path || 'unknown file',
              tool: 'MultiEdit',
              detail: `${Array.isArray(input.edits) ? input.edits.length : '?'} edit(s)`,
              timestamp: entry.timestamp
            });
          } else if (block.name === 'Write') {
            changes.push({
              file: input.file_path || 'unknown file',
              tool: 'Write',
              detail: 'file created/overwritten',
              timestamp: entry.timestamp
            });
          } else if (block.name === 'NotebookEdit') {
            changes.push({
              file: input.notebook_path || 'unknown notebook',
              tool: 'NotebookEdit',
              detail: 'notebook cell edited',
              timestamp: entry.timestamp
            });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return changes;
}

// Group raw file changes by file (relative to the project dir) for display/prompt use.
// Files outside the project dir (multi-project sessions) and unresolved paths are skipped,
// since they can't be safely `git add`-ed from this repo.
function groupChangesByFile(changes: FileChange[], baseDir: string): { file: string; tools: string[]; count: number }[] {
  const map = new Map<string, { tools: Set<string>; count: number }>();

  for (const c of changes) {
    if (c.file === 'unknown file' || c.file === 'unknown notebook') continue;
    const key = path.isAbsolute(c.file) ? path.relative(baseDir, c.file) : c.file;
    if (key.startsWith('..')) continue;
    if (!map.has(key)) map.set(key, { tools: new Set(), count: 0 });
    const entry = map.get(key)!;
    entry.tools.add(c.tool);
    entry.count++;
  }

  return Array.from(map.entries()).map(([file, v]) => ({ file, tools: Array.from(v.tools), count: v.count }));
}

// Distribute grouped file changes as evenly as possible into at most `count` commit buckets
function chunkFilesForCommits(grouped: { file: string }[], count: number): string[][] {
  if (grouped.length === 0 || count <= 0) return [];
  const bucketCount = Math.min(count, grouped.length);
  const buckets: string[][] = Array.from({ length: bucketCount }, () => []);
  grouped.forEach((g, i) => buckets[i % bucketCount].push(g.file));
  return buckets;
}

// Stage and commit each file bucket as a real Git commit, in order
function applyCommits(commits: any[], fileBuckets: string[][], projDir: string): { applied: number; errors: string[] } {
  let applied = 0;
  const errors: string[] = [];

  for (let i = 0; i < commits.length; i++) {
    const files = fileBuckets[i];
    if (!files || files.length === 0) {
      errors.push(`Commit #${i + 1}: no real file(s) mapped, skipped.`);
      continue;
    }
    try {
      execFileSync('git', ['add', '--', ...files], { cwd: projDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', commits[i].subject || 'Update', '-m', commits[i].body || '', '--author', commits[i].author, '--', ...files], { cwd: projDir, stdio: 'pipe' });
      applied++;
    } catch (err: any) {
      const message = (err.stderr?.toString() || err.message || '').split('\n')[0];
      errors.push(`Commit #${i + 1} (${files.join(', ')}): ${message}`);
    }
  }

  return { applied, errors };
}

// Check whether the local `claude` executable (Claude Code CLI) is installed and on PATH
function isClaudeCliAvailable(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const p = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\n')[0];
    return p || null;
  } catch {
    return null;
  }
}

// Track how many terminal rows a chunk of text advances the cursor by, accounting for line wraps.
// Uses relative cursor movement math (not absolute save/restore) so it stays correct even if the
// terminal scrolls while long content streams in.
function advanceRows(text: string, startCol: number, terminalWidth: number): { rows: number; endCol: number } {
  let col = startCol;
  let rows = 0;
  for (const ch of text) {
    if (ch === '\n') {
      rows++;
      col = 0;
    } else {
      col++;
      if (col >= terminalWidth) {
        rows++;
        col = 0;
      }
    }
  }
  return { rows, endCol: col };
}

// Move the cursor back to the start of `rows` rows of previously-printed output and erase them
function eraseRows(rows: number) {
  if (rows > 0) process.stdout.write(`\x1b[${rows}A`);
  process.stdout.write('\r\x1b[0J');
}

// Run the local Claude Code CLI in streaming mode, printing its output live as it's generated
function runClaudeCliStreaming(prompt: string, cwd: string, onText: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--verbose'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buffer = '';
    let finalResult = '';
    let errOutput = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
            onText(event.event.delta.text);
          } else if (event.type === 'result') {
            finalResult = event.result ?? '';
          }
        } catch {
          // Skip malformed / partial JSON lines
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      errOutput += chunk.toString('utf-8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !finalResult) {
        reject(new Error(errOutput.trim() || `claude exited with code ${code}`));
      } else {
        resolve(finalResult);
      }
    });
  });
}

// Generate high fidelity procedural fallback commits
function generateProceduralCommits(count: number, projectName: string) {
  const stages = ["chore: init setup", "feat(db): schema definitions", "feat(core): core engines", "feat(ui): terminal renderer", "test: active validator specs"];
  const commits = [];
  const start = Date.now() - count * 24 * 60 * 60 * 1000;
  
  for (let i = 0; i < count; i++) {
    const stage = stages[i % stages.length];
    const timestamp = new Date(start + i * 24 * 60 * 60 * 1000).toLocaleString();
    const hash = Math.random().toString(16).substring(2, 9);
    
    commits.push({
      hash,
      subject: `${stage} - checkpoint progress #${i+1}`,
      body: `Automated progressive build verification for the active code module of ${projectName}.`,
      timestamp,
      author: "Claude Code <claude@anthropic.com>"
    });
  }
  return commits;
}

// Offline fallback that groups real Claude Code file changes into commits (no AI required)
function generateProceduralCommitsFromChanges(changes: FileChange[], count: number, projectName: string, projDir: string) {
  const grouped = groupChangesByFile(changes, projDir);
  const commits = [];
  const start = Date.now() - count * 24 * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const group = grouped[i % grouped.length];
    const timestamp = new Date(start + i * 24 * 60 * 60 * 1000).toLocaleString();
    const hash = Math.random().toString(16).substring(2, 9);
    const verb = group.tools.length === 1 && group.tools[0] === 'Write' ? 'add' : 'update';

    commits.push({
      hash,
      subject: `chore: ${verb} ${group.file}`,
      body: `Based on ${group.count} real modification(s) made by Claude Code to ${group.file} (${group.tools.join(', ')}) in ${projectName}.`,
      timestamp,
      author: "Claude Code <claude@anthropic.com>"
    });
  }
  return commits;
}

// Main logic
async function main() {
  // Load environment variables from local .env if available
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[key] = value;
      }
    });
  }

  while (true) {
    clearScreen();
    
    // Immersive cyber dashboard header
    console.log(`${C.brightCyan}${C.bold}╒═════════════════════════════════════════════════════════════════════╕${C.reset}`);
    console.log(`${C.brightCyan}${C.bold}│             🤖   CLAUDE CODE TUI COMPANION TERMINAL CLI   🤖        │${C.reset}`);
    console.log(`${C.brightCyan}${C.bold}╘═════════════════════════════════════════════════════════════════════╛${C.reset}`);
    
    const activeDirName = path.basename(process.cwd()).toUpperCase();
    console.log(`${C.dim}📁 ACTIVE DIRECTORY : ${C.reset}${C.brightWhite}${C.bold}${activeDirName}${C.reset}`);
    console.log(`${C.dim}🌐 PLATFORM         : ${C.reset}${C.brightYellow}${os.type()} (${os.arch()})${C.reset}`);
    
    const claudeDir = locateClaudeCodeDir();
    if (claudeDir) {
      console.log(`${C.dim}🔌 CLAUDE CLI STATUS: ${C.reset}${C.green}${C.bold}CONNECTED${C.reset} ${C.dim}(at ${claudeDir})${C.reset}`);
    } else {
      console.log(`${C.dim}🔌 CLAUDE CLI STATUS: ${C.reset}${C.yellow}STANDALONE MODE${C.reset} ${C.dim}(Claude Code not found locally)${C.reset}`);
    }
    
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      const isAnthropic = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
      console.log(`${C.dim}🔑 CREDENTIAL ENGINE: ${C.reset}${C.green}${C.bold}ACTIVE${C.reset} ${C.dim}(Type: ${isAnthropic ? 'Anthropic Claude' : 'Google Gemini'})${C.reset}`);
    } else {
      console.log(`${C.dim}🔑 CREDENTIAL ENGINE: ${C.reset}${C.red}${C.bold}OFFLINE${C.reset} ${C.dim}(using offline procedural generator)${C.reset}`);
    }
    console.log(`${C.dim}───────────────────────────────────────────────────────────────────────${C.reset}\n`);

    console.log(`${C.brightCyan}${C.bold}[1]${C.reset} 📁 Scan Local File Explorer & Git History`);
    console.log(`${C.brightCyan}${C.bold}[2]${C.reset} 💬 Locate & Read Local Claude Code Sessions`);
    console.log(`${C.brightCyan}${C.bold}[3]${C.reset} 📅 Interactive Git Commit Timeline Suggester`);
    console.log(`${C.brightCyan}${C.bold}[4]${C.reset} ⚙️  Configure API Keys & Diagnostics`);
    console.log(`${C.brightCyan}${C.bold}[5]${C.reset} 🌐 Launch Web-TUI Interactive Dashboard`);
    console.log(`${C.brightRed}${C.bold}[6]${C.reset} ❌ Exit CLI\n`);
    
    const ans = await question(`${C.brightWhite}${C.bold}Select option [1-6]: ${C.reset}`);
    const choice = ans.trim();

    if (choice === '1') {
      clearScreen();
      console.log(`${C.brightCyan}${C.bold}📁 SCAN LOCAL FILE EXPLORER & GIT HISTORY${C.reset}`);
      console.log(`${C.dim}----------------------------------------------------------------------${C.reset}\n`);

      const rawDir = await question(`Enter a folder path to scan (${C.dim}default: current directory${C.reset}): `);
      const targetDir = rawDir.trim() ? resolvePath(rawDir) : process.cwd();

      clearScreen();
      console.log(`${C.brightCyan}${C.bold}📁 SCANNING WORKSPACE AND LOCAL GIT STATUS...${C.reset}`);
      console.log(`${C.dim}Target: ${C.reset}${C.brightWhite}${targetDir}${C.reset}\n`);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        console.log(`${C.red}⚠️ Path does not exist or is not a directory.${C.reset}`);
        await pressEnterToContinue();
        continue;
      }

      if (!isGitRepo(targetDir)) {
        console.log(`${C.yellow}⚠️ Warning: Target directory is not a Git repository.${C.reset}`);
      } else {
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetDir }).toString().trim();
          console.log(`${C.bold}Branch: ${C.reset}${C.cyan}${branch}${C.reset}`);

          console.log(`\n${C.bold}Recent Git Commits:${C.reset}`);
          const log = execSync('git log -n 5 --oneline', { cwd: targetDir }).toString().trim();
          console.log(log ? log : `${C.dim}No commits found.${C.reset}`);

          console.log(`\n${C.bold}Uncommitted changes (git status):${C.reset}`);
          const status = execSync('git status --short', { cwd: targetDir }).toString().trim();
          console.log(status ? `${C.brightYellow}${status}${C.reset}` : `${C.green}Your workspace is clean!${C.reset}`);
        } catch (err: any) {
          console.log(`${C.red}Failed to execute Git commands: ${err.message}${C.reset}`);
        }
      }

      console.log(`\n${C.bold}Root Files & Sizes:${C.reset}`);
      try {
        const files = fs.readdirSync(targetDir);
        files.slice(0, 15).forEach(f => {
          if (f === 'node_modules' || f === '.git' || f === 'dist') return;
          const stats = fs.statSync(path.join(targetDir, f));
          const sizeKb = (stats.size / 1024).toFixed(1);
          console.log(`  ${stats.isDirectory() ? `${C.brightCyan}DIR ` : `${C.brightGreen}FILE`} ${sizeKb.padStart(6)}K${C.reset}  ${f}`);
        });
        if (files.length > 15) {
          console.log(`  ${C.dim}... and ${files.length - 15} more files${C.reset}`);
        }
      } catch (err: any) {
        console.log(`${C.red}Failed to list files: ${err.message}${C.reset}`);
      }

      await pressEnterToContinue();
    }
    else if (choice === '2') {
      clearScreen();
      console.log(`${C.brightCyan}${C.bold}💬 LOCATE & READ LOCAL CLAUDE CODE SESSIONS${C.reset}`);
      console.log(`${C.dim}----------------------------------------------------------------------${C.reset}\n`);

      const rawProjDir = await question(`Which project folder's chat history do you want to view? (${C.dim}default: current directory${C.reset}): `);
      const targetProj = rawProjDir.trim().length > 0 ? resolvePath(rawProjDir) : process.cwd();

      clearScreen();
      console.log(`${C.brightCyan}${C.bold}💬 SEARCHING FOR LOCAL CLAUDE CODE CHAT RECORDS...${C.reset}`);
      console.log(`${C.dim}Project: ${C.reset}${C.brightWhite}${targetProj}${C.reset}\n`);

      if (!fs.existsSync(targetProj) || !fs.statSync(targetProj).isDirectory()) {
        console.log(`${C.red}⚠️ Path does not exist or is not a directory.${C.reset}`);
        await pressEnterToContinue();
        continue;
      }

      const { claudeHome, sessionDir, summaries } = findProjectSessions(targetProj);
      if (!claudeHome) {
        console.log(`${C.yellow}No local Claude Code config folder found.${C.reset}`);
        console.log(`Claude Code typically stores persistent session cache in:`);
        console.log(`  - macOS: ~/Library/Application Support/claude-code/`);
        console.log(`  - Linux: ~/.config/claude-code/ or ~/.claude/`);
        console.log(`  - Windows: %APPDATA%\\claude-code\\`);
        console.log(`\n${C.dim}Tip: Make sure you have installed Claude Code globally via:${C.reset}`);
        console.log(`  ${C.brightCyan}npm i -g @anthropic-ai/claude-code${C.reset}`);
        await pressEnterToContinue();
        continue;
      }

      if (!sessionDir) {
        console.log(`${C.yellow}No chat history found for this project.${C.reset}`);
        console.log(`${C.dim}(Looked in: ${path.join(claudeHome, 'projects', encodeProjectPath(targetProj))})${C.reset}`);
        await pressEnterToContinue();
        continue;
      }

      if (summaries.length === 0) {
        console.log(`${C.yellow}No chat sessions found for this project.${C.reset}`);
        await pressEnterToContinue();
        continue;
      }

      console.log(`${C.green}✔ Found ${summaries.length} chat session(s):${C.reset}\n`);
      summaries.forEach((s, idx) => {
        console.log(`${C.brightCyan}${C.bold}[${idx + 1}]${C.reset} ${C.bold}${C.white}${s.title || '(untitled session)'}${C.reset} ${C.dim}- ${s.mtime.toLocaleString()} (${s.messageCount} messages)${C.reset}`);
        console.log(`    ${C.dim}"${s.firstUserMessage || '(no user message)'}"${C.reset}`);
      });

      const rawPick = await question(`\nEnter a session number to view its transcript (${C.dim}or press Enter to skip${C.reset}): `);
      const pick = parseInt(rawPick.trim());

      if (!isNaN(pick) && pick >= 1 && pick <= summaries.length) {
        const chosen = summaries[pick - 1];
        const transcript = readSessionTranscript(chosen.filePath);

        console.log(`\n${C.brightCyan}${C.bold}📜 TRANSCRIPT: ${chosen.title || chosen.file}${C.reset}`);
        console.log(`${C.dim}----------------------------------------------------------------------${C.reset}\n`);
        transcript.forEach(m => {
          const roleColor = m.role === 'user' ? C.brightYellow : C.brightGreen;
          const roleLabel = m.role === 'user' ? 'USER' : 'CLAUDE';
          console.log(`${roleColor}${C.bold}[${roleLabel}]${C.reset} ${C.dim}${new Date(m.timestamp).toLocaleString()}${C.reset}`);
          console.log(`${m.text}\n`);
        });
      }

      await pressEnterToContinue();
    }
    else if (choice === '3') {
      clearScreen();
      console.log(`${C.brightCyan}${C.bold}📅 INTERACTIVE GIT COMMIT TIMELINE SUGGESTER${C.reset}`);
      console.log(`${C.dim}----------------------------------------------------------------------${C.reset}\n`);
      
      const rawProjDir = await question(`Enter a project folder path (${C.dim}default: current directory${C.reset}): `);
      const projDir = rawProjDir.trim().length > 0 ? resolvePath(rawProjDir) : process.cwd();

      if (!fs.existsSync(projDir) || !fs.statSync(projDir).isDirectory()) {
        console.log(`\n${C.red}⚠️ Path does not exist or is not a directory: ${projDir}${C.reset}`);
        await pressEnterToContinue();
        continue;
      }

      const projName = path.basename(projDir);
      const gitAuthor = getGitAuthor(projDir);
      const rawCount = await question(`How many commits would you like to suggest? (default: 5): `);
      const count = parseInt(rawCount) || 5;

      const rawDays = await question(`Over how many days of timeline history? (default: 3): `);
      const days = parseInt(rawDays) || 3;

      console.log(`\n${C.bold}Base suggestions on real Claude Code modifications?${C.reset}`);
      console.log(`  [1] A specific chat session`);
      console.log(`  [2] All sessions for this project (general)`);
      console.log(`  [3] No - generate generic suggestions`);
      const rawBasis = await question(`Choice (default: 3): `);
      const basisChoice = rawBasis.trim() || '3';

      let changes: FileChange[] = [];
      let basisLabel = 'Generic (no session data)';

      if (basisChoice === '1' || basisChoice === '2') {
        const sessions = findProjectSessions(projDir);
        if (!sessions.claudeHome || !sessions.sessionDir || sessions.summaries.length === 0) {
          console.log(`${C.yellow}No Claude Code chat history found for this project — falling back to generic suggestions.${C.reset}`);
        } else if (basisChoice === '2') {
          changes = extractFileChanges(sessions.summaries.map(s => s.filePath));
          basisLabel = changes.length > 0
            ? `General - ${sessions.summaries.length} session(s), ${changes.length} file change(s)`
            : 'Generic (no file changes recorded across sessions)';
        } else {
          console.log(`\n${C.bold}Available sessions:${C.reset}`);
          sessions.summaries.forEach((s, idx) => {
            console.log(`${C.brightCyan}${C.bold}[${idx + 1}]${C.reset} ${C.white}${s.title || '(untitled session)'}${C.reset} ${C.dim}- ${s.mtime.toLocaleString()} (${s.messageCount} messages)${C.reset}`);
          });
          const rawPick = await question(`\nEnter a session number (${C.dim}default: most recent${C.reset}): `);
          const pick = parseInt(rawPick.trim());
          const chosen = (!isNaN(pick) && pick >= 1 && pick <= sessions.summaries.length) ? sessions.summaries[pick - 1] : sessions.summaries[0];
          changes = extractFileChanges([chosen.filePath]);
          basisLabel = changes.length > 0
            ? `Session "${chosen.title || chosen.file}" - ${changes.length} file change(s)`
            : `Generic (no file changes recorded in session "${chosen.title || chosen.file}")`;
        }
      }

      console.log(`\n${C.brightYellow}Generating timeline spanning ${days} days for project "${projName}" (${C.dim}${projDir}${C.reset}${C.brightYellow})...${C.reset}`);
      console.log(`${C.dim}Basis: ${C.reset}${C.bold}${basisLabel}${C.reset}`);

      const changeSummaryLines = changes.length > 0
        ? groupChangesByFile(changes, projDir).slice(0, 40).map(g => `- ${g.file} (${g.tools.join(', ')}, ${g.count}x)`).join('\n')
        : '';

      const prompt = changes.length > 0 ? `
            You are helping organize real Claude Code work into ${count} progressive git commits for the project "${projName}" over ${days} days.
            Here is the actual list of file modifications made by Claude Code during the selected session(s):
            ${changeSummaryLines}

            Group these real changes into a logical, chronological sequence of ${count} commits that accurately reflects the work actually done. Do not invent unrelated work.
            Return a JSON array of Git commits in this format:
            [{
              "hash": "7-char hex",
              "subject": "commit subject",
              "body": "commit body details",
              "timestamp": "relative or iso date string",
              "author": "${gitAuthor}"
            }]
            Return ONLY the raw JSON array.
          ` : `
            You are helping plan ${count} progressive commits for ${projName} over ${days} days.
            Return a JSON array of Git commits in this format:
            [{
              "hash": "7-char hex",
              "subject": "commit subject",
              "body": "commit body details",
              "timestamp": "relative or iso date string",
              "author": "${gitAuthor}"
            }]
            Return ONLY the raw JSON array.
          `;

      const parseJsonCommits = (text: string) => {
        const cleanText = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
        return JSON.parse(cleanText);
      };

      const printCommits = (commits: any[], intelligent: boolean, method: string) => {
        console.log(`\n${C.green}✔ Generated ${commits.length} ${intelligent ? 'intelligent' : 'chronological'} commits ${C.dim}(method: ${C.reset}${C.bold}${method}${C.reset}${C.dim})${C.reset}\n`);
        commits.forEach((c: any, idx: number) => {
          console.log(`${C.brightCyan}${C.bold}[COMMIT #${idx+1}]${C.reset}`);
          console.log(`  ${C.bold}Hash:   ${C.reset}${C.brightYellow}${c.hash}${C.reset}`);
          console.log(`  ${C.bold}Subject:${C.reset} ${C.white}${c.subject}${C.reset}`);
          console.log(`  ${C.bold}Body:   ${C.reset}${C.dim}${c.body}${C.reset}`);
          console.log(`  ${C.bold}Date:   ${C.reset}${C.magenta}${c.timestamp}${C.reset}`);
          if (c.author) console.log(`  ${C.bold}Author: ${C.reset}${c.author}`);
          console.log();
        });
      };

      let commits: any[] | null = null;
      let intelligent = false;
      let method = 'Procedural (offline generator)';

      const claudeCliPath = isClaudeCliAvailable();
      if (claudeCliPath) {
        console.log(`${C.dim}✔ Local Claude Code CLI detected (at ${claudeCliPath}) — consulting it directly...${C.reset}`);
        console.log(`${C.dim}----------------------------------------------------------------------${C.reset}`);

        const terminalWidth = process.stdout.columns || 80;
        let liveRows = 0;
        let liveCol = 0;

        try {
          const text = await runClaudeCliStreaming(prompt, projDir, (chunk) => {
            process.stdout.write(`${C.dim}${chunk}${C.reset}`);
            const { rows, endCol } = advanceRows(chunk, liveCol, terminalWidth);
            liveRows += rows;
            liveCol = endCol;
          });
          eraseRows(liveRows);
          commits = parseJsonCommits(text);
          intelligent = true;
          method = 'Claude Code CLI (local)';
        } catch (err: any) {
          eraseRows(liveRows);
          console.log(`${C.yellow}Local Claude Code CLI call failed: ${err.message}${C.reset}`);
        }
      }

      if (!commits) {
        const keySource = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY'
          : process.env.CLAUDE_API_KEY ? 'CLAUDE_API_KEY'
          : process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY'
          : null;

        if (keySource) {
          const key = process.env[keySource]!;
          const isAnthropic = keySource === 'ANTHROPIC_API_KEY' || keySource === 'CLAUDE_API_KEY';
          console.log(`${C.dim}Consulting AI Planner via ${C.reset}${C.bold}${keySource}${C.reset}${C.dim} for intelligent chronological progression...${C.reset}`);
          try {
            let text = '';

            if (isAnthropic) {
              const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": key,
                  "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                  model: "claude-3-5-sonnet-20241022",
                  max_tokens: 2000,
                  messages: [{ role: "user", content: prompt }]
                })
              });
              const data: any = await response.json();
              text = data.content?.[0]?.text || '';
            } else {
              // Gemini API call
              const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: { responseMimeType: "application/json" }
                })
              });
              const data: any = await response.json();
              text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            }

            commits = parseJsonCommits(text);
            intelligent = true;
            method = keySource;
          } catch (err: any) {
            console.log(`${C.red}AI request failed: ${err.message}. Falling back to procedural timeline generator.${C.reset}`);
          }
        }
      }

      if (!commits) {
        commits = changes.length > 0
          ? generateProceduralCommitsFromChanges(changes, count, projName, projDir)
          : generateProceduralCommits(count, projName);
        intelligent = false;
        method = 'Procedural (offline generator)';
      }

      commits = commits.map((c: any) => ({ ...c, author: gitAuthor }));

      printCommits(commits, intelligent, method);

      let readyToApply = changes.length > 0 && isGitRepo(projDir);

      if (changes.length === 0) {
        console.log(`${C.dim}(Apply option unavailable: these are generic suggestions with no real file mapping. Pick a session-based basis to enable applying.)${C.reset}`);
      } else if (!isGitRepo(projDir)) {
        console.log(`${C.yellow}${projDir} is not a Git repository yet.${C.reset}`);
        const rawInit = await question(`Initialize a Git repository here now? (y/N): `);
        if (rawInit.trim().toLowerCase() === 'y') {
          try {
            execFileSync('git', ['init'], { cwd: projDir, stdio: 'pipe' });

            const authorMatch = gitAuthor.match(/^(.*?)\s*<([^>]+)>$/);
            if (authorMatch) {
              execFileSync('git', ['config', 'user.name', authorMatch[1]], { cwd: projDir, stdio: 'pipe' });
              execFileSync('git', ['config', 'user.email', authorMatch[2]], { cwd: projDir, stdio: 'pipe' });
            }

            console.log(`${C.green}✔ Initialized empty Git repository in ${projDir}${C.reset}`);

            const rawRemote = await question(`Add a Git remote URL now? (${C.dim}optional, press Enter to skip${C.reset}): `);
            if (rawRemote.trim()) {
              try {
                execFileSync('git', ['remote', 'add', 'origin', rawRemote.trim()], { cwd: projDir, stdio: 'pipe' });
                console.log(`${C.green}✔ Remote 'origin' set to ${rawRemote.trim()}${C.reset}`);
              } catch (err: any) {
                console.log(`${C.red}Failed to add remote: ${err.message}${C.reset}`);
              }
            }

            readyToApply = true;
          } catch (err: any) {
            console.log(`${C.red}Failed to initialize Git repository: ${err.message}${C.reset}`);
          }
        } else {
          console.log(`${C.dim}Skipped - no Git repository was initialized.${C.reset}`);
        }
      }

      if (readyToApply) {
        const fileGroups = groupChangesByFile(changes, projDir);
        const fileBuckets = chunkFilesForCommits(fileGroups, commits.length);
        commits = commits.map((c: any, i: number) => ({ ...c, files: fileBuckets[i] || [] }));

        console.log(`${C.bold}Each commit above maps to these real file(s):${C.reset}`);
        commits.forEach((c: any, idx: number) => {
          console.log(`  [${idx + 1}] ${c.files.length > 0 ? c.files.join(', ') : `${C.dim}(no real files - will be skipped)${C.reset}`}`);
        });

        const rawApply = await question(`\n${C.brightRed}${C.bold}Apply these ${commits.length} commit(s) to the local Git repository now? (y/N): ${C.reset}`);
        if (rawApply.trim().toLowerCase() === 'y') {
          console.log(`\n${C.brightYellow}Applying commits...${C.reset}`);
          const { applied, errors } = applyCommits(commits, fileBuckets, projDir);
          console.log(`${C.green}✔ Applied ${applied}/${commits.length} commit(s).${C.reset}`);
          if (errors.length > 0) {
            console.log(`${C.red}Issues:${C.reset}`);
            errors.forEach(e => console.log(`  - ${e}`));
          }
          console.log(`${C.dim}Review with: git log --oneline -n ${commits.length}${C.reset}`);
        } else {
          console.log(`${C.dim}Skipped - no commits were applied.${C.reset}`);
        }
      }

      await pressEnterToContinue();
    }
    else if (choice === '4') {
      clearScreen();
      console.log(`${C.brightCyan}${C.bold}⚙️ CONFIGURE API KEYS & DIAGNOSTICS${C.reset}`);
      console.log(`${C.dim}----------------------------------------------------------------------${C.reset}\n`);
      
      console.log(`Active Environment variables:`);
      console.log(`  - ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? `${C.green}SET (Ends in ...${process.env.ANTHROPIC_API_KEY.slice(-4)})${C.reset}` : `${C.red}NOT SET${C.reset}`}`);
      console.log(`  - CLAUDE_API_KEY:    ${process.env.CLAUDE_API_KEY ? `${C.green}SET (Ends in ...${process.env.CLAUDE_API_KEY.slice(-4)})${C.reset}` : `${C.red}NOT SET${C.reset}`}`);
      console.log(`  - GEMINI_API_KEY:    ${process.env.GEMINI_API_KEY ? `${C.green}SET (Ends in ...${process.env.GEMINI_API_KEY.slice(-4)})${C.reset}` : `${C.red}NOT SET${C.reset}`}`);
      
      console.log(`\n${C.bold}To modify these keys, set them in your terminal:${C.reset}`);
      console.log(`  Windows: ${C.cyan}set ANTHROPIC_API_KEY=your_key${C.reset}`);
      console.log(`  macOS/Linux: ${C.cyan}export ANTHROPIC_API_KEY="your_key"${C.reset}`);
      console.log(`Or define them in a local ${C.bold}.env${C.reset} file in this directory.`);
      
      await pressEnterToContinue();
    } 
    else if (choice === '5') {
      clearScreen();
      console.log(`${C.brightCyan}${C.bold}🌐 SPINNING UP LOCAL WEB-TUI COMPANION SERVER...${C.reset}`);
      console.log(`${C.dim}----------------------------------------------------------------------${C.reset}\n`);
      
      console.log(`This starts the backend unifier Express server serving the React Web TUI.`);
      console.log(`Once running, you can connect your browser to:`);
      console.log(`  ${C.brightCyan}${C.bold}http://localhost:3000${C.reset}\n`);
      
      console.log(`${C.brightYellow}Tip: Run "npm run dev" or "npm run start" to boot the server easily!${C.reset}`);
      console.log(`Starting background server process diagnostic...`);
      
      try {
        const net = require('net');
        const tester = net.createServer()
          .once('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
              console.log(`${C.green}✔ Port 3000 is currently occupied (Server is already running!)${C.reset}`);
            } else {
              console.log(`${C.red}Port check failed: ${err.message}${C.reset}`);
            }
          })
          .once('listening', () => {
            tester.close();
            console.log(`${C.yellow}Port 3000 is free. Launch the server in a separate window using:${C.reset}`);
            console.log(`  ${C.brightCyan}npm run dev${C.reset}`);
          })
          .listen(3000);
      } catch {
        console.log(`Checking completed.`);
      }
      
      await pressEnterToContinue();
    } 
    else if (choice === '6') {
      console.log(`\n${C.brightCyan}Thank you for using Claude Code TUI Companion! Safe hacking! 🚀${C.reset}`);
      rl.close();
      process.exit(0);
    }
  }
}

main().catch(err => {
  console.error("CLI Execution failed:", err);
  process.exit(1);
});

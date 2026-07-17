import { execSync, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as os from 'os';

// ANSI escape codes for styling
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
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

interface CommitUnit {
  file: string;     // path relative to the project dir
  absPath: string;  // absolute path on disk
  content: string;  // real file content at this point in history
  time: Date;
}

// Read a file's content, tolerating files that no longer exist
function readFileContentSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// Reconstruct the real, chronological sequence of file-content snapshots for a project using
// Claude Code's own file-history backups (~/.claude/file-history/<sessionId>/<hash>@vN). This is
// what lets a single file that was edited many times across a session become several real,
// meaningful commits instead of being collapsed into one. Files with no recoverable backup
// history fall back to a single unit using their current on-disk content.
function buildCommitUnits(sessionFilePaths: string[], claudeHome: string | null, projDir: string, fallbackChanges: FileChange[]): CommitUnit[] {
  const versions = new Map<string, { version: number; content: string; time: Date }[]>();

  if (claudeHome) {
    for (const sessionFilePath of sessionFilePaths) {
      const sessionId = path.basename(sessionFilePath, '.jsonl');
      const historyDir = path.join(claudeHome, 'file-history', sessionId);
      if (!fs.existsSync(historyDir)) continue;

      let lines: string[];
      try {
        lines = fs.readFileSync(sessionFilePath, 'utf-8').split('\n').filter(Boolean);
      } catch {
        continue;
      }

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'file-history-snapshot') continue;
          const backups = entry.snapshot?.trackedFileBackups;
          if (!backups || typeof backups !== 'object') continue;

          for (const [filePath, info] of Object.entries<any>(backups)) {
            if (!info?.backupFileName) continue;
            const absFile = path.isAbsolute(filePath) ? filePath : path.join(projDir, filePath);
            const relFile = path.relative(projDir, absFile);
            if (relFile.startsWith('..')) continue;

            const content = readFileContentSafe(path.join(historyDir, info.backupFileName));
            if (content === null) continue;

            const list = versions.get(relFile) || [];
            if (!list.some(v => v.version === info.version)) {
              list.push({ version: info.version, content, time: new Date(info.backupTime || entry.snapshot?.timestamp) });
              versions.set(relFile, list);
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  const units: CommitUnit[] = [];

  for (const [relFile, list] of versions.entries()) {
    list.sort((a, b) => a.version - b.version);
    const absPath = path.join(projDir, relFile);

    // Each backup is the state right before the next tracked edit - i.e. the target state
    // for the transition that follows it chronologically.
    for (let i = 1; i < list.length; i++) {
      units.push({ file: relFile, absPath, content: list[i].content, time: list[i].time });
    }

    // Final transition: from the last backup to whatever is actually on disk right now.
    const current = readFileContentSafe(absPath);
    if (current !== null && current !== list[list.length - 1].content) {
      units.push({ file: relFile, absPath, content: current, time: new Date() });
    } else if (list.length === 1) {
      units.push({ file: relFile, absPath, content: list[0].content, time: list[0].time });
    }
  }

  // Files the session touched but with no recoverable backup history: one unit, current content.
  const grouped = groupChangesByFile(fallbackChanges, projDir);
  for (const g of grouped) {
    if (versions.has(g.file)) continue;
    const absPath = path.join(projDir, g.file);
    const current = readFileContentSafe(absPath);
    if (current === null) continue;
    const lastTimestamp = fallbackChanges
      .filter(c => (path.isAbsolute(c.file) ? path.relative(projDir, c.file) : c.file) === g.file)
      .map(c => new Date(c.timestamp))
      .sort((a, b) => b.getTime() - a.getTime())[0] || new Date();
    units.push({ file: g.file, absPath, content: current, time: lastTimestamp });
  }

  units.sort((a, b) => a.time.getTime() - b.time.getTime());
  return units;
}

// Distribute chronologically-ordered commit units into at most `count` contiguous buckets,
// preserving order both within and across buckets.
function chunkUnitsIntoCommits(units: CommitUnit[], count: number): CommitUnit[][] {
  if (units.length === 0 || count <= 0) return [];
  const bucketCount = Math.min(count, units.length);
  const perBucket = Math.ceil(units.length / bucketCount);
  const buckets: CommitUnit[][] = Array.from({ length: bucketCount }, () => []);
  units.forEach((u, i) => {
    const idx = Math.min(Math.floor(i / perBucket), bucketCount - 1);
    buckets[idx].push(u);
  });
  return buckets;
}

// Write each bucket's real historical file content, commit it, and move on - reconstructing the
// actual progression of the work. Every touched file is guaranteed to be left at its true current
// content on disk when this returns, even if a commit fails partway through.
function applyCommitUnits(commits: any[], unitBuckets: CommitUnit[][], projDir: string): { applied: number; errors: string[] } {
  let applied = 0;
  const errors: string[] = [];

  const restoreMap = new Map<string, string | null>();
  for (const bucket of unitBuckets) {
    for (const u of bucket) {
      if (!restoreMap.has(u.absPath)) {
        restoreMap.set(u.absPath, readFileContentSafe(u.absPath));
      }
    }
  }

  try {
    for (let i = 0; i < commits.length; i++) {
      const bucket = unitBuckets[i];
      if (!bucket || bucket.length === 0) {
        errors.push(`Commit #${i + 1}: no real file state mapped, skipped.`);
        continue;
      }

      const latestPerFile = new Map<string, CommitUnit>();
      for (const u of bucket) latestPerFile.set(u.absPath, u);

      const files: string[] = [];
      try {
        for (const u of latestPerFile.values()) {
          fs.writeFileSync(u.absPath, u.content, 'utf-8');
          files.push(path.relative(projDir, u.absPath));
        }
        execFileSync('git', ['add', '--', ...files], { cwd: projDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', commits[i].subject || 'Update', '-m', commits[i].body || '', '--author', commits[i].author, '--', ...files], { cwd: projDir, stdio: 'pipe' });
        applied++;
      } catch (err: any) {
        const message = (err.stderr?.toString() || err.message || '').split('\n')[0];
        errors.push(`Commit #${i + 1} (${files.join(', ')}): ${message}`);
      }
    }
  } finally {
    for (const [absPath, content] of restoreMap.entries()) {
      if (content !== null) {
        try {
          fs.writeFileSync(absPath, content, 'utf-8');
        } catch {
          // best effort
        }
      }
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

// Offline fallback that turns real, chronologically-ordered commit-unit buckets into commits
// (no AI required) - one commit per bucket, in the order the work actually happened.
function generateProceduralCommitsFromUnits(unitBuckets: CommitUnit[][], projectName: string) {
  const commits: any[] = [];
  const start = Date.now() - unitBuckets.length * 24 * 60 * 60 * 1000;

  unitBuckets.forEach((bucket, i) => {
    const files = Array.from(new Set(bucket.map(u => u.file)));
    const timestamp = new Date(start + i * 24 * 60 * 60 * 1000).toLocaleString();
    const hash = Math.random().toString(16).substring(2, 9);
    const label = files.length === 1 ? files[0] : `${files.length} files`;

    commits.push({
      hash,
      subject: `chore: update ${label}`,
      body: `Reconstructed from ${bucket.length} real change(s) made by Claude Code to ${files.join(', ')} in ${projectName}.`,
      timestamp,
      author: "Claude Code <claude@anthropic.com>"
    });
  });
  return commits;
}

// Print a plain bordered banner (no emoji, single accent color)
function printBanner() {
  const width = 74;
  const title = 'Claude Commit Planner';
  const subtitle = 'Generate and apply Git commit plans grounded in real Claude Code session history.';

  const wrapLine = (text: string): string[] => {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const w of words) {
      const next = current ? `${current} ${w}` : w;
      if (next.length > width - 4) {
        lines.push(current);
        current = w;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  const bodyLines = [title, '', ...wrapLine(subtitle)];

  console.log(`${C.cyan}┌${'─'.repeat(width - 2)}┐${C.reset}`);
  bodyLines.forEach((line, idx) => {
    const styled = idx === 0 ? `${C.bold}${line}${C.reset}` : `${C.dim}${line}${C.reset}`;
    const padding = ' '.repeat(Math.max(width - 4 - line.length, 0));
    console.log(`${C.cyan}│${C.reset} ${styled}${padding} ${C.cyan}│${C.reset}`);
  });
  console.log(`${C.cyan}└${'─'.repeat(width - 2)}┘${C.reset}`);
  console.log();

  const claudeCliPath = isClaudeCliAvailable();
  console.log(`  ${C.dim}Claude Code CLI${C.reset}   ${claudeCliPath ? `${C.green}Connected${C.reset} ${C.dim}(${claudeCliPath})${C.reset}` : `${C.yellow}Not found on PATH${C.reset}`}`);

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.GEMINI_API_KEY;
  console.log(`  ${C.dim}Credentials${C.reset}       ${apiKey ? `${C.green}Configured${C.reset}` : `${C.yellow}Not set${C.reset} ${C.dim}(procedural fallback will be used if needed)${C.reset}`}`);
  console.log();
}

// Interactive commit-timeline planner: pick a project, ground it in real Claude Code
// session data (optional), generate a commit plan, and optionally apply it as real commits.
async function runCommitPlanner() {
  const rawProjDir = await question(`Project folder (${C.dim}default: current directory${C.reset}): `);
  const projDir = rawProjDir.trim().length > 0 ? resolvePath(rawProjDir) : process.cwd();

  if (!fs.existsSync(projDir) || !fs.statSync(projDir).isDirectory()) {
    console.log(`\n${C.red}Path does not exist or is not a directory: ${projDir}${C.reset}`);
    return;
  }

  const projName = path.basename(projDir);
  const gitAuthor = getGitAuthor(projDir);
  const rawCount = await question(`How many commits would you like to suggest? (default: 5): `);
  const count = parseInt(rawCount) || 5;

  const rawDays = await question(`Over how many days of timeline history? (default: 3): `);
  const days = parseInt(rawDays) || 3;

  console.log(`\n${C.bold}Base suggestions on real Claude Code modifications?${C.reset}`);
  console.log(`  1. A specific chat session`);
  console.log(`  2. All sessions for this project (general)`);
  console.log(`  3. No - generate generic suggestions`);
  const rawBasis = await question(`Choice (default: 3): `);
  const basisChoice = rawBasis.trim() || '3';

  let changes: FileChange[] = [];
  let sessionFilePaths: string[] = [];
  let claudeHomeForUnits: string | null = null;
  let basisLabel = 'Generic (no session data)';

  if (basisChoice === '1' || basisChoice === '2') {
    const sessions = findProjectSessions(projDir);
    claudeHomeForUnits = sessions.claudeHome;
    if (!sessions.claudeHome || !sessions.sessionDir || sessions.summaries.length === 0) {
      console.log(`${C.yellow}No Claude Code chat history found for this project - falling back to generic suggestions.${C.reset}`);
    } else if (basisChoice === '2') {
      sessionFilePaths = sessions.summaries.map(s => s.filePath);
      changes = extractFileChanges(sessionFilePaths);
      basisLabel = changes.length > 0
        ? `General - ${sessions.summaries.length} session(s), ${changes.length} file change(s)`
        : 'Generic (no file changes recorded across sessions)';
    } else {
      console.log(`\n${C.bold}Available sessions:${C.reset}`);
      sessions.summaries.forEach((s, idx) => {
        console.log(`  ${C.bold}${idx + 1}.${C.reset} ${s.title || '(untitled session)'} ${C.dim}- ${s.mtime.toLocaleString()} (${s.messageCount} messages)${C.reset}`);
      });
      const rawPick = await question(`\nSession number (${C.dim}default: most recent${C.reset}): `);
      const pick = parseInt(rawPick.trim());
      const chosen = (!isNaN(pick) && pick >= 1 && pick <= sessions.summaries.length) ? sessions.summaries[pick - 1] : sessions.summaries[0];
      sessionFilePaths = [chosen.filePath];
      changes = extractFileChanges(sessionFilePaths);
      basisLabel = changes.length > 0
        ? `Session "${chosen.title || chosen.file}" - ${changes.length} file change(s)`
        : `Generic (no file changes recorded in session "${chosen.title || chosen.file}")`;
    }
  }

  // Reconstruct the real, chronological progression of every touched file (using Claude Code's own
  // file-history backups where available) so a single file edited many times can become several real
  // commits, not just one. The number of commits we can actually apply is capped by how many of
  // these real change-units exist - align the requested count to that up front.
  const commitUnits = changes.length > 0 ? buildCommitUnits(sessionFilePaths, claudeHomeForUnits, projDir, changes) : [];
  const effectiveCount = commitUnits.length > 0 ? Math.min(count, commitUnits.length) : count;
  const unitBuckets = commitUnits.length > 0 ? chunkUnitsIntoCommits(commitUnits, effectiveCount) : [];

  console.log(`\n${C.dim}Generating a ${effectiveCount}-commit plan spanning ${days} day(s) for "${projName}"...${C.reset}`);
  console.log(`${C.dim}Basis: ${C.reset}${C.bold}${basisLabel}${C.reset}`);
  if (effectiveCount !== count) {
    console.log(`${C.yellow}Only ${commitUnits.length} real change(s) were recovered, so the plan is capped at ${effectiveCount} commit(s) instead of the requested ${count} (each commit needs a real change to apply).${C.reset}`);
  }

  const changeSummaryLines = unitBuckets.length > 0
    ? unitBuckets.map((bucket, i) => {
        const files = Array.from(new Set(bucket.map(u => u.file)));
        const when = bucket[bucket.length - 1].time.toLocaleString();
        return `Commit ${i + 1}: ${files.join(', ')} (${bucket.length} change(s), around ${when})`;
      }).join('\n')
    : '';

  const prompt = changes.length > 0 ? `
        You are writing ${effectiveCount} git commit messages (subject + body only) describing real work Claude Code did on "${projName}" over ${days} days.
        The commits are already grouped and ordered for you from the real file-change history - keep this exact order and grouping, do not add, remove, merge, or reorder commits:
        ${changeSummaryLines}

        Write a clear, specific subject and body for each commit reflecting what actually changed in that group.
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
        You are helping plan ${effectiveCount} progressive commits for ${projName} over ${days} days.
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
    console.log(`\n${C.green}Generated ${commits.length} ${intelligent ? 'intelligent' : 'chronological'} commits ${C.dim}(method: ${C.reset}${C.bold}${method}${C.reset}${C.dim})${C.reset}\n`);
    commits.forEach((c: any, idx: number) => {
      console.log(`${C.brightCyan}${C.bold}Commit ${idx + 1}${C.reset}`);
      console.log(`  ${C.bold}Hash:   ${C.reset}${C.brightYellow}${c.hash}${C.reset}`);
      console.log(`  ${C.bold}Subject:${C.reset} ${C.white}${c.subject}${C.reset}`);
      console.log(`  ${C.bold}Body:   ${C.reset}${C.dim}${c.body}${C.reset}`);
      console.log(`  ${C.bold}Date:   ${C.reset}${c.timestamp}`);
      if (c.author) console.log(`  ${C.bold}Author: ${C.reset}${c.author}`);
      console.log();
    });
  };

  let commits: any[] | null = null;
  let intelligent = false;
  let method = 'Procedural (offline generator)';

  const claudeCliPath = isClaudeCliAvailable();
  if (claudeCliPath) {
    console.log(`${C.dim}Local Claude Code CLI detected (${claudeCliPath}) - consulting it directly...${C.reset}`);
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
      console.log(`${C.dim}Consulting AI planner via ${C.reset}${C.bold}${keySource}${C.reset}${C.dim}...${C.reset}`);
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
    commits = unitBuckets.length > 0
      ? generateProceduralCommitsFromUnits(unitBuckets, projName)
      : generateProceduralCommits(effectiveCount, projName);
    intelligent = false;
    method = 'Procedural (offline generator)';
  }

  commits = commits.map((c: any) => ({ ...c, author: gitAuthor }));

  printCommits(commits, intelligent, method);

  let readyToApply = commitUnits.length > 0 && isGitRepo(projDir);

  if (changes.length === 0) {
    console.log(`${C.dim}(Apply unavailable: these are generic suggestions with no real file mapping. Pick a session-based basis to enable applying.)${C.reset}`);
  } else if (commitUnits.length === 0) {
    console.log(`${C.dim}(Apply unavailable: none of the recorded changes map to files inside this project folder.)${C.reset}`);
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

        console.log(`${C.green}Initialized empty Git repository in ${projDir}${C.reset}`);

        const rawRemote = await question(`Add a Git remote URL now? (${C.dim}optional, press Enter to skip${C.reset}): `);
        if (rawRemote.trim()) {
          try {
            execFileSync('git', ['remote', 'add', 'origin', rawRemote.trim()], { cwd: projDir, stdio: 'pipe' });
            console.log(`${C.green}Remote 'origin' set to ${rawRemote.trim()}${C.reset}`);
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
    commits = commits.map((c: any, i: number) => ({ ...c, files: Array.from(new Set((unitBuckets[i] || []).map(u => u.file))) }));

    console.log(`${C.bold}Each commit above maps to these real file(s):${C.reset}`);
    commits.forEach((c: any, idx: number) => {
      console.log(`  ${idx + 1}. ${c.files.length > 0 ? c.files.join(', ') : `${C.dim}(no real files - will be skipped)${C.reset}`}`);
    });

    const rawApply = await question(`\n${C.brightRed}${C.bold}Apply these ${commits.length} commit(s) to the local Git repository now? (y/N): ${C.reset}`);
    if (rawApply.trim().toLowerCase() === 'y') {
      console.log(`\n${C.dim}Applying commits (writing each real historical state, one commit at a time)...${C.reset}`);
      const { applied, errors } = applyCommitUnits(commits, unitBuckets, projDir);
      console.log(`${C.green}Applied ${applied}/${commits.length} commit(s).${C.reset}`);
      if (errors.length > 0) {
        console.log(`${C.red}Issues:${C.reset}`);
        errors.forEach(e => console.log(`  - ${e}`));
      }
      console.log(`${C.dim}Review with: git log --oneline -n ${commits.length}${C.reset}`);
    } else {
      console.log(`${C.dim}Skipped - no commits were applied.${C.reset}`);
    }
  }
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

  clearScreen();
  printBanner();

  let again = true;
  while (again) {
    await runCommitPlanner();
    const rawAgain = await question(`\n${C.dim}Generate another commit plan? (y/N): ${C.reset}`);
    again = rawAgain.trim().toLowerCase() === 'y';
    if (again) {
      clearScreen();
      printBanner();
    }
  }

  console.log(`\n${C.dim}Goodbye.${C.reset}`);
  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error("CLI Execution failed:", err);
  process.exit(1);
});

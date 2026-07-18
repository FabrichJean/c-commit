import { execSync, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as os from 'os';
import { diffLines } from 'diff';

// 24-bit true-color helper, for exact hex theme colors
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

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
  white: '\x1b[37m',

  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightWhite: '\x1b[97m',

  // Global theme, anchored on #285669
  theme: rgb(40, 86, 105),        // #285669 - structural (borders, secondary labels)
  themeVivid: rgb(57, 168, 213),  // vivid, more saturated/brighter version of the same hue - accents, titles
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

// Arrow-key navigable option picker: up/down to move, Enter to confirm, Ctrl+C to exit.
// Falls back to returning the first option immediately when stdin isn't a real TTY.
function selectOption(promptText: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.log(`${C.bold}${promptText}${C.reset} ${C.themeVivid}${options[0]}${C.reset}`);
      resolve(0);
      return;
    }

    let selected = 0;

    const renderOptions = () => {
      options.forEach((opt, i) => {
        const isSelected = i === selected;
        const marker = isSelected ? `${C.themeVivid}${C.bold}>${C.reset}` : ' ';
        const label = isSelected ? `${C.themeVivid}${opt}${C.reset}` : `${C.dim}${opt}${C.reset}`;
        console.log(` ${marker} ${label}`);
      });
    };

    console.log(`${C.bold}${promptText}${C.reset} ${C.dim}(use arrow keys, Enter to confirm)${C.reset}`);
    renderOptions();

    const onKeypress = (_str: string, key: any) => {
      if (!key) return;
      if (key.name === 'up') {
        selected = (selected - 1 + options.length) % options.length;
        eraseRows(options.length);
        renderOptions();
      } else if (key.name === 'down') {
        selected = (selected + 1) % options.length;
        eraseRows(options.length);
        renderOptions();
      } else if (key.name === 'return') {
        eraseRows(options.length + 1);
        console.log(`${C.bold}${promptText}${C.reset} ${C.themeVivid}${options[selected]}${C.reset}`);
        cleanup();
        resolve(selected);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log(`\n${C.dim}Goodbye.${C.reset}`);
        process.exit(0);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rl.resume();
    };

    rl.pause();
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKeypress);
    process.stdin.resume();
  });
}

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

// The author date of HEAD, or null if the repo has no commits yet
const getLastCommitDate = (dir: string): Date | null => {
  try {
    const output = execSync('git log -1 --format=%aI', { cwd: dir, stdio: 'pipe' }).toString().trim();
    if (!output) return null;
    const d = new Date(output);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
};

// If the project isn't a Git repo yet, offer to initialize one (with an optional remote) up
// front. This must happen before any Git-based scanning (e.g. untracked file detection via
// `git ls-files`) - otherwise those checks silently see no repository and find nothing.
const offerGitInitIfNeeded = async (projDir: string, gitAuthor: string): Promise<void> => {
  if (isGitRepo(projDir)) return;

  console.log(`${C.yellow}${projDir} is not a Git repository yet.${C.reset}`);
  const rawInit = await question(`Initialize a Git repository here now? (y/N): `);
  if (rawInit.trim().toLowerCase() !== 'y') {
    console.log(`${C.dim}Skipped - no Git repository was initialized.${C.reset}`);
    return;
  }

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
  } catch (err: any) {
    console.log(`${C.red}Failed to initialize Git repository: ${err.message}${C.reset}`);
  }
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
  before: string;   // content right before this transition (for further line-level splitting)
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

// Reliable-enough binary detection: legitimate UTF-8 text never contains a null byte, but
// arbitrary binary content (images, .DS_Store, lockfile-adjacent blobs, ...) read as 'utf-8'
// usually will. Binary files can't be turned into a sensible diff/commit message anyway, and a
// null byte in a spawn() argument crashes the process outright ("must be a string without null
// bytes"), so these are skipped rather than turned into a commit unit.
function isBinaryContent(content: string): boolean {
  return content.includes('\0');
}

// Read a file's content as it was in the last commit (HEAD), tolerating new/untracked files
function getGitHeadContent(projDir: string, relFile: string): string | null {
  try {
    const content = execFileSync('git', ['show', `HEAD:${relFile.split(path.sep).join('/')}`], { cwd: projDir, stdio: 'pipe' }).toString();
    return isBinaryContent(content) ? null : content;
  } catch {
    return null;
  }
}

// Untracked files (not covered by .gitignore), relative to projDir - catches files a Claude
// Code session created via a Bash command rather than the Edit/Write/MultiEdit/NotebookEdit
// tools, which extractFileChanges() has no way to see.
function getUntrackedFiles(projDir: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: projDir, stdio: 'pipe' })
      .toString()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Build commit units directly from whatever is currently sitting in the working tree - modified,
// staged, or untracked files per `git status` - with no Claude Code session involved at all.
// Each unit diffs the file's current content against HEAD (or against '' for new/untracked
// files), so this plugs into the same splitting/bucketing/apply pipeline as session-based units.
function buildCommitUnitsFromGitDiff(projDir: string): CommitUnit[] {
  let statusOutput: string;
  try {
    statusOutput = execFileSync('git', ['status', '--porcelain'], { cwd: projDir, stdio: 'pipe' }).toString();
  } catch {
    return [];
  }

  const units: CommitUnit[] = [];

  for (const line of statusOutput.split('\n')) {
    if (!line.trim()) continue;
    const statusCode = line.slice(0, 2);
    if (statusCode.includes('D')) continue; // deleted files have no content to commit here

    let relFile = line.slice(3).trim();
    if (relFile.includes(' -> ')) relFile = relFile.split(' -> ')[1]; // renames: use the new path
    if (relFile.startsWith('"') && relFile.endsWith('"')) relFile = relFile.slice(1, -1);

    const absPath = path.join(projDir, relFile);
    const current = readFileContentSafe(absPath);
    if (current === null || isBinaryContent(current)) continue;

    const isUntracked = statusCode.includes('?');
    const before = isUntracked ? '' : (getGitHeadContent(projDir, relFile) ?? '');
    if (before === current) continue;

    let mtime: Date;
    try {
      mtime = fs.statSync(absPath).mtime;
    } catch {
      mtime = new Date();
    }

    units.push({ file: relFile, absPath, before, content: current, time: mtime });
  }

  units.sort((a, b) => a.time.getTime() - b.time.getTime());
  return units;
}

// A short, token-frugal excerpt of what actually changed between two versions of a file - a
// handful of +/- lines, so the AI (or a human reading the prompt) knows the real content of the
// change, not just which file was touched.
function summarizeDiffForPrompt(before: string, after: string, maxLines: number = 4): string {
  if (before === after) return '';
  const parts = diffLines(before, after);
  const out: string[] = [];

  for (const part of parts) {
    if (out.length >= maxLines) break;
    if (!part.added && !part.removed) continue;
    const prefix = part.added ? '+' : '-';
    for (const line of part.value.split('\n')) {
      if (!line) continue;
      if (out.length >= maxLines) break;
      out.push(`${prefix} ${line.length > 100 ? line.slice(0, 100) + '…' : line}`);
    }
  }

  return out.join('\n');
}

// Reconstruct the real, chronological sequence of file-content snapshots for a project using
// Claude Code's own file-history backups (~/.claude/file-history/<sessionId>/<hash>@vN). This is
// what lets a single file that was edited many times across a session become several real,
// meaningful commits instead of being collapsed into one. Files with no recoverable backup
// history fall back to a single unit using their current on-disk content.
function buildCommitUnits(sessionFilePaths: string[], claudeHome: string | null, projDir: string, fallbackChanges: FileChange[]): { units: CommitUnit[]; untrackedCount: number } {
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
      units.push({ file: relFile, absPath, before: list[i - 1].content, content: list[i].content, time: list[i].time });
    }

    // Final transition: from the last backup to whatever is actually on disk right now.
    const current = readFileContentSafe(absPath);
    if (current !== null && !isBinaryContent(current) && current !== list[list.length - 1].content) {
      units.push({ file: relFile, absPath, before: list[list.length - 1].content, content: current, time: new Date() });
    } else if (list.length === 1) {
      const before = getGitHeadContent(projDir, relFile) ?? list[0].content;
      units.push({ file: relFile, absPath, before, content: list[0].content, time: list[0].time });
    }
  }

  // Files the session touched but with no recoverable backup history: one unit, current content,
  // diffed against the last committed (HEAD) version when available so it can still be split.
  const grouped = groupChangesByFile(fallbackChanges, projDir);
  for (const g of grouped) {
    if (versions.has(g.file)) continue;
    const absPath = path.join(projDir, g.file);
    const current = readFileContentSafe(absPath);
    if (current === null || isBinaryContent(current)) continue;
    const before = getGitHeadContent(projDir, g.file) ?? '';
    const lastTimestamp = fallbackChanges
      .filter(c => (path.isAbsolute(c.file) ? path.relative(projDir, c.file) : c.file) === g.file)
      .map(c => new Date(c.timestamp))
      .sort((a, b) => b.getTime() - a.getTime())[0] || new Date();
    units.push({ file: g.file, absPath, before, content: current, time: lastTimestamp });
  }

  // Files currently untracked in Git but not represented above - most likely created via a
  // Bash command (touch, cp, a generator script, ...) rather than one of the tracked tools.
  const coveredFiles = new Set<string>([...versions.keys(), ...grouped.map(g => g.file)]);
  const untrackedFiles = getUntrackedFiles(projDir).filter(f => !coveredFiles.has(f));
  for (const relFile of untrackedFiles) {
    const absPath = path.join(projDir, relFile);
    const current = readFileContentSafe(absPath);
    if (current === null || isBinaryContent(current)) continue;
    let mtime: Date;
    try {
      mtime = fs.statSync(absPath).mtime;
    } catch {
      mtime = new Date();
    }
    units.push({ file: relFile, absPath, before: '', content: current, time: mtime });
  }

  units.sort((a, b) => a.time.getTime() - b.time.getTime());
  return { units, untrackedCount: untrackedFiles.length };
}

// A single paired change step: replacing one old line with one new line (either side may be
// absent for a pure addition or pure deletion). Pairing removals with additions line-by-line
// avoids the ugly "delete everything, then add everything back" progression a naive flat
// remove-then-add token stream would produce for a fully-rewritten block.
type MicroStep =
  | { kind: 'context'; text: string }
  | { kind: 'change'; removeLine?: string; addLine?: string };

function splitIntoLines(text: string): string[] {
  return text.split(/(?<=\n)/).filter(l => l.length > 0);
}

function buildMicroSteps(before: string, after: string): MicroStep[] {
  const parts = diffLines(before, after);
  const steps: MicroStep[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      steps.push({ kind: 'context', text: part.value });
      i++;
      continue;
    }
    let removedLines: string[] = [];
    let addedLines: string[] = [];
    if (parts[i]?.removed) {
      removedLines = splitIntoLines(parts[i].value);
      i++;
    }
    if (parts[i]?.added) {
      addedLines = splitIntoLines(parts[i].value);
      i++;
    }
    const pairCount = Math.max(removedLines.length, addedLines.length);
    for (let k = 0; k < pairCount; k++) {
      steps.push({ kind: 'change', removeLine: removedLines[k], addLine: addedLines[k] });
    }
  }
  return steps;
}

// Reconstruct the document after the first `appliedCount` change-steps have "landed" - not-yet-applied
// steps still show their old line, already-applied steps show their new line.
function reconstructFromMicroSteps(steps: MicroStep[], appliedCount: number): string {
  let seen = 0;
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === 'context') {
      out.push(s.text);
      continue;
    }
    seen++;
    if (seen <= appliedCount) {
      if (s.addLine) out.push(s.addLine);
    } else {
      if (s.removeLine) out.push(s.removeLine);
    }
  }
  return out.join('');
}

// Split a before -> after transition into up to `steps` real, cumulative intermediate states,
// using a line-level diff so every intermediate state is an actual step toward the final content.
// Capped at the number of changed lines - can't usefully split further than that.
function splitContentIntoSteps(before: string, after: string, steps: number): string[] {
  if (steps <= 1 || before === after) return [after];
  const microSteps = buildMicroSteps(before, after);
  const totalChanges = microSteps.filter(s => s.kind === 'change').length;
  if (totalChanges === 0) return [after];

  const effectiveSteps = Math.min(steps, totalChanges);
  const result: string[] = [];
  for (let s = 1; s <= effectiveSteps; s++) {
    const appliedCount = Math.round((s / effectiveSteps) * totalChanges);
    result.push(reconstructFromMicroSteps(microSteps, appliedCount));
  }
  result[result.length - 1] = after; // guard against any rounding drift
  return result;
}

// When there aren't enough natural change-units to reach the requested commit count, split the
// largest available diffs line-by-line so we can still produce as many commits as were asked
// for, up to the total amount of real changed lines available.
function expandUnitsToCount(units: CommitUnit[], targetCount: number): CommitUnit[] {
  if (units.length === 0 || units.length >= targetCount) return units;

  const capacities = units.map(u => u.before === u.content ? 0 : buildMicroSteps(u.before, u.content).filter(s => s.kind === 'change').length);
  const totalCapacity = capacities.reduce((a, b) => a + b, 0);
  if (totalCapacity <= units.length) return units;

  const desiredExtra = targetCount - units.length;
  const result: CommitUnit[] = [];

  units.forEach((u, idx) => {
    const cap = capacities[idx];
    if (cap <= 1) {
      result.push(u);
      return;
    }
    const share = Math.max(1, Math.round((cap / totalCapacity) * desiredExtra));
    const steps = Math.min(cap, share + 1);
    if (steps <= 1) {
      result.push(u);
      return;
    }
    const contents = splitContentIntoSteps(u.before, u.content, steps);
    contents.forEach((c, i) => {
      const staggerMs = (contents.length - 1 - i) * 1000;
      const before = i === 0 ? u.before : contents[i - 1];
      result.push({ file: u.file, absPath: u.absPath, before, content: c, time: new Date(u.time.getTime() - staggerMs) });
    });
  });

  return result.sort((a, b) => a.time.getTime() - b.time.getTime());
}

// Distribute chronologically-ordered commit units into at most `count` contiguous buckets,
// preserving order both within and across buckets. Every bucket is guaranteed at least one
// unit: the first `remainder` buckets get one extra item so nothing is ever left empty.
function chunkUnitsIntoCommits(units: CommitUnit[], count: number): CommitUnit[][] {
  if (units.length === 0 || count <= 0) return [];
  const bucketCount = Math.min(count, units.length);
  const base = Math.floor(units.length / bucketCount);
  const remainder = units.length % bucketCount;

  const buckets: CommitUnit[][] = [];
  let idx = 0;
  for (let b = 0; b < bucketCount; b++) {
    const size = base + (b < remainder ? 1 : 0);
    buckets.push(units.slice(idx, idx + size));
    idx += size;
  }
  return buckets;
}

// Write each bucket's real historical file content, commit it, and move on - reconstructing the
// actual progression of the work. Every touched file is guaranteed to be left at its true current
// content on disk when this returns, even if a commit fails partway through.
// Parse a commit's stored timestamp into an ISO 8601 string Git will accept for
// GIT_AUTHOR_DATE/GIT_COMMITTER_DATE, or null if it can't be parsed
function toGitDate(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

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

        const gitDate = toGitDate(commits[i].timestamp);
        const commitEnv = gitDate ? { ...process.env, GIT_AUTHOR_DATE: gitDate, GIT_COMMITTER_DATE: gitDate } : process.env;
        execFileSync('git', ['commit', '-m', commits[i].subject || 'Update', '-m', commits[i].body || '', '--author', commits[i].author, '--', ...files], { cwd: projDir, stdio: 'pipe', env: commitEnv });
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
    // This is a one-shot text task (write commit messages, return JSON) - no tools, MCP servers,
    // or Claude Code's full default system prompt are needed. Without these flags, every call
    // pays ~10-30k tokens of fixed agentic overhead (tool definitions, memory, skills) before a
    // single token of actual work; with them, that drops to a few hundred.
    const child = spawn('claude', [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--tools', '',
      '--strict-mcp-config',
      '--system-prompt', 'You are a git commit message writer. You do not use any tools. Respond only with the exact output format requested, with no preamble, explanation, or commentary.'
    ], {
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
    const timestamp = new Date(start + i * 24 * 60 * 60 * 1000).toISOString();
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
    const timestamp = new Date(start + i * 24 * 60 * 60 * 1000).toISOString();
    const hash = Math.random().toString(16).substring(2, 9);
    const label = files.length === 1 ? files[0] : `${files.length} files`;

    // Describe THIS bucket's own subdivision, not just "a change happened" - each bucket can be
    commits.push({
      hash,
      subject: `chore: update ${label}`,
      body: `Reconstructed from ${bucket.length} real change(s) to ${files.join(', ')} in ${projectName}.`,
      timestamp,
      author: "Claude Code <claude@anthropic.com>"
    });
  });
  return commits;
}

// Length of a string as it will actually appear on screen, ignoring ANSI escape codes
function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Truncate plain (uncolored) text to fit a visible-column budget, with an ellipsis if cut
function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  return text.slice(0, maxWidth - 1) + '…';
}

// A small bracketed status badge, e.g. "[ CONNECTED ]"
function badge(text: string, color: string): string {
  return `${color}${C.bold}[ ${text} ]${C.reset}`;
}

// Wrap plain text into lines that each fit within `maxWidth` visible columns
function wrapToWidth(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length > maxWidth) {
      lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Print a double-bordered banner with a status section, in the global theme (no emoji).
// Sizes itself to the current terminal width, and drops the border entirely below a
// minimum width where a box would just look broken.
function printBanner() {
  const termWidth = process.stdout.columns || 80;

  const claudeCliPath = isClaudeCliAvailable();
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.GEMINI_API_KEY;

  const cliBadge = claudeCliPath ? badge('CONNECTED', C.green) : badge('NOT FOUND', C.yellow);
  const credBadge = apiKey ? badge('CONFIGURED', C.green) : badge('NOT SET', C.yellow);
  const cliDetail = claudeCliPath || 'not found on PATH';
  const credDetail = apiKey ? '' : 'procedural fallback ready';

  const MIN_BOX_WIDTH = 44;

  if (termWidth < MIN_BOX_WIDTH) {
    // Too narrow for a readable box - plain stacked lines instead
    console.log(`${C.themeVivid}${C.bold}Claude Commit Planner${C.reset}`);
    wrapToWidth('Generate and apply Git commit plans grounded in real Claude Code session history.', termWidth)
      .forEach(l => console.log(`${C.dim}${l}${C.reset}`));
    console.log();
    console.log(`${C.dim}Claude Code CLI${C.reset} ${cliBadge}`);
    console.log(`  ${C.dim}${truncateToWidth(cliDetail, Math.max(termWidth - 2, 4))}${C.reset}`);
    console.log(`${C.dim}Credentials${C.reset} ${credBadge}`);
    if (credDetail) console.log(`  ${C.dim}${truncateToWidth(credDetail, Math.max(termWidth - 2, 4))}${C.reset}`);
    console.log();
    return;
  }

  const width = Math.min(78, termWidth - 2);
  const innerWidth = width - 4;

  const titleLine = `${C.themeVivid}${C.bold}Claude Commit Planner${C.reset}`;
  const subtitleLines = wrapToWidth('Generate and apply Git commit plans grounded in real Claude Code session history.', innerWidth)
    .map(l => `${C.dim}${l}${C.reset}`);

  const statusRow = (label: string, statusBadge: string, detail: string) => {
    const labelPart = `${C.dim}${label.padEnd(16)}${C.reset}`;
    const usedWidth = visibleLength(labelPart) + 1 + visibleLength(statusBadge) + (detail ? 2 : 0);
    const detailBudget = Math.max(innerWidth - usedWidth, 0);
    const truncatedDetail = truncateToWidth(detail, detailBudget);
    const detailPart = truncatedDetail ? `  ${C.dim}${truncatedDetail}${C.reset}` : '';
    return `${labelPart} ${statusBadge}${detailPart}`;
  };

  const statusLines = [
    statusRow('Claude Code CLI', cliBadge, cliDetail),
    statusRow('Credentials', credBadge, credDetail),
  ];

  const printRow = (content: string) => {
    const padding = ' '.repeat(Math.max(innerWidth - visibleLength(content), 0));
    console.log(`${C.theme}║${C.reset} ${content}${padding} ${C.theme}║${C.reset}`);
  };

  console.log(`${C.theme}╔${'═'.repeat(width - 2)}╗${C.reset}`);
  [titleLine, '', ...subtitleLines].forEach(printRow);
  console.log(`${C.theme}╠${'═'.repeat(width - 2)}╣${C.reset}`);
  statusLines.forEach(printRow);
  console.log(`${C.theme}╚${'═'.repeat(width - 2)}╝${C.reset}`);
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

  console.log();
  const basisIndex = await selectOption('How should commits be grounded?', [
    'A specific Claude Code chat session',
    'All Claude Code sessions for this project (general)',
    'Current Git changes (diff) - no Claude Code session needed',
    'No - generate generic suggestions'
  ]);
  const basisChoice = String(basisIndex + 1);

  let changes: FileChange[] = [];
  let sessionFilePaths: string[] = [];
  let claudeHomeForUnits: string | null = null;
  let gitDiffUnits: CommitUnit[] = [];
  let attemptedRealBasis = false;
  let basisLabel = 'Generic (no session data)';

  if (basisChoice === '1' || basisChoice === '2') {
    attemptedRealBasis = true;
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
      console.log();
      const sessionLabels = sessions.summaries.map(s => `${s.title || '(untitled session)'} - ${s.mtime.toLocaleString()} (${s.messageCount} messages)`);
      const pickIndex = await selectOption('Available sessions:', sessionLabels);
      const chosen = sessions.summaries[pickIndex];
      sessionFilePaths = [chosen.filePath];
      changes = extractFileChanges(sessionFilePaths);
      basisLabel = changes.length > 0
        ? `Session "${chosen.title || chosen.file}" - ${changes.length} file change(s)`
        : `Generic (no file changes recorded in session "${chosen.title || chosen.file}")`;
    }
  } else if (basisChoice === '3') {
    attemptedRealBasis = true;
  }

  // Get the repo into a real Git state now, before any Git-based scanning below (the untracked
  // file catch-up in buildCommitUnits, and the Git-diff basis itself, both need a real
  // repository to query, or they silently find nothing - see offerGitInitIfNeeded's comment).
  if (attemptedRealBasis) {
    await offerGitInitIfNeeded(projDir, gitAuthor);
  }

  if (basisChoice === '3') {
    gitDiffUnits = isGitRepo(projDir) ? buildCommitUnitsFromGitDiff(projDir) : [];
    basisLabel = gitDiffUnits.length > 0
      ? `Current Git changes - ${gitDiffUnits.length} file change(s)`
      : 'Generic (no uncommitted Git changes found)';
  }

  // Reconstruct the real, chronological progression of every touched file (using Claude Code's own
  // file-history backups where available) so a single file edited many times can become several real
  // commits, not just one. If there still aren't enough natural change-units to hit the requested
  // count, split the largest diffs line-by-line to get closer to it, up to how much real change exists.
  let commitUnits: CommitUnit[] = [];
  let untrackedCount = 0;
  if (sessionFilePaths.length > 0) {
    // Run this even if extractFileChanges() found nothing - a session that only ran Bash
    // commands (no Edit/Write/MultiEdit/NotebookEdit calls) would otherwise never be checked
    // for untracked files it left behind.
    const built = buildCommitUnits(sessionFilePaths, claudeHomeForUnits, projDir, changes);
    commitUnits = built.units;
    untrackedCount = built.untrackedCount;
  } else if (gitDiffUnits.length > 0) {
    commitUnits = gitDiffUnits;
  }
  if (commitUnits.length > 0 && commitUnits.length < count) {
    commitUnits = expandUnitsToCount(commitUnits, count);
  }
  const effectiveCount = commitUnits.length > 0 ? Math.min(count, commitUnits.length) : count;
  const unitBuckets = commitUnits.length > 0 ? chunkUnitsIntoCommits(commitUnits, effectiveCount) : [];

  if (untrackedCount > 0) {
    basisLabel = changes.length > 0
      ? `${basisLabel} (+${untrackedCount} untracked file(s) from git status)`
      : basisLabel.replace(/^Generic \(no file changes recorded[^)]*\)$/, `Generic - ${untrackedCount} untracked file(s) from git status only`);
  }

  console.log(`\n${C.dim}Generating a ${effectiveCount}-commit plan spanning ${days} day(s) for "${projName}"...${C.reset}`);
  console.log(`${C.dim}Basis: ${C.reset}${C.bold}${basisLabel}${C.reset}`);
  if (effectiveCount !== count) {
    console.log(`${C.yellow}Only ${commitUnits.length} real change(s) were recovered, so the plan is capped at ${effectiveCount} commit(s) instead of the requested ${count} (each commit needs a real change to apply).${C.reset}`);
  }

  const changeSummaryLines = unitBuckets.length > 0
    ? unitBuckets.map((bucket, i) => {
        const files = Array.from(new Set(bucket.map(u => u.file)));
        const when = bucket[bucket.length - 1].time.toLocaleString();
        const header = `Commit ${i + 1}: ${files.join(', ')} (${bucket.length} change(s), around ${when})`;
        // A short real diff excerpt per file (capped) so the AI knows what actually changed,
        // not just which files were touched.
        const excerpts = bucket.slice(0, 3)
          .map(u => summarizeDiffForPrompt(u.before, u.content, 4))
          .filter(Boolean)
          .join('\n');
        return excerpts ? `${header}\n${excerpts}` : header;
      }).join('\n\n')
    : '';

  const prompt = commitUnits.length > 0 ? `
        You are writing ${effectiveCount} git commit messages (subject + body only) describing real code changes in "${projName}" over ${days} days.
        The commits are already grouped and ordered for you from the real file-change history, including short diff excerpts for context - keep this exact order and grouping, do not add, remove, merge, or reorder commits:
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
      console.log(`${C.themeVivid}${C.bold}Commit ${idx + 1}${C.reset}`);
      console.log(`  ${C.bold}Hash:   ${C.reset}${C.brightYellow}${c.hash}${C.reset}`);
      console.log(`  ${C.bold}Subject:${C.reset} ${C.white}${c.subject}${C.reset}`);
      console.log(`  ${C.bold}Body:   ${C.reset}${C.dim}${c.body}${C.reset}`);
      const parsedDate = new Date(c.timestamp);
      const dateDisplay = isNaN(parsedDate.getTime()) ? c.timestamp : parsedDate.toLocaleString();
      console.log(`  ${C.bold}Date:   ${C.reset}${dateDisplay}`);
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

  if (!attemptedRealBasis) {
    console.log(`${C.dim}(Apply unavailable: these are generic suggestions with no real file mapping. Pick a session or Git-diff basis to enable applying.)${C.reset}`);
  } else if (commitUnits.length === 0) {
    console.log(`${C.dim}(Apply unavailable: none of the recorded changes map to files inside this project folder.)${C.reset}`);
  } else if (!isGitRepo(projDir)) {
    console.log(`${C.dim}(Apply unavailable: ${projDir} is still not a Git repository - it was not initialized earlier.)${C.reset}`);
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

// Download the latest release for this platform and replace the currently running binary with
// it. Only meaningful when running as the compiled `cmt` executable (pkg sets `process.pkg`) -
// running this from source (tsx) would otherwise try to overwrite the system node/tsx binary.
async function runSelfUpdate(): Promise<void> {
  const REPO_SLUG = 'FabrichJean/ccommit';

  if (!(process as any).pkg) {
    console.log(`${C.yellow}'cmt update' only works in the compiled binary, not when running from source.${C.reset}`);
    console.log(`${C.dim}From a clone, use 'git pull' instead.${C.reset}`);
    process.exit(1);
  }

  let asset: string | null = null;
  if (process.platform === 'darwin') {
    asset = process.arch === 'arm64' ? 'commit-planner-macos-arm64' : process.arch === 'x64' ? 'commit-planner-macos-x64' : null;
  } else if (process.platform === 'linux') {
    asset = process.arch === 'x64' ? 'commit-planner-linux-x64' : null;
  } else if (process.platform === 'win32') {
    asset = process.arch === 'x64' ? 'commit-planner-win-x64.exe' : null;
  }

  if (!asset) {
    console.log(`${C.red}Unsupported platform for self-update: ${process.platform}/${process.arch}${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.dim}Checking the latest release of ${REPO_SLUG}...${C.reset}`);

  let latestTag = '';
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`);
    if (res.ok) {
      const data: any = await res.json();
      latestTag = data.tag_name || '';
    }
  } catch {
    // Non-fatal - we can still download the "latest" asset without knowing its tag name
  }

  const downloadUrl = `https://github.com/${REPO_SLUG}/releases/latest/download/${asset}`;
  console.log(`${C.dim}Downloading ${asset}${latestTag.length > 0 ? ` (${latestTag})` : ''}...${C.reset}`);

  let bytes: Buffer;
  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    console.log(`${C.red}Download failed: ${err.message}${C.reset}`);
    process.exit(1);
  }

  const currentPath = process.execPath;
  const dir = path.dirname(currentPath);
  const tempPath = path.join(dir, `.${path.basename(currentPath)}.new`);

  try {
    fs.writeFileSync(tempPath, bytes);
    fs.chmodSync(tempPath, 0o755);

    if (process.platform === 'darwin') {
      try {
        execFileSync('codesign', ['--force', '--sign', '-', tempPath], { stdio: 'pipe' });
      } catch {
        // Best effort - proceed even if codesign isn't available
      }
    }

    if (process.platform === 'win32') {
      // Windows won't let you overwrite a running executable in place, but it will let you
      // rename it out of the way first.
      const backupPath = `${currentPath}.old`;
      try { fs.unlinkSync(backupPath); } catch {}
      fs.renameSync(currentPath, backupPath);
      fs.renameSync(tempPath, currentPath);
      try { fs.unlinkSync(backupPath); } catch {}
    } else {
      // Same-directory rename is atomic and safe even while this exact file is currently
      // executing - the running process keeps its old inode open until it exits.
      fs.renameSync(tempPath, currentPath);
    }
  } catch (err: any) {
    try { fs.unlinkSync(tempPath); } catch {}
    console.log(`${C.red}Failed to replace the current binary: ${err.message}${C.reset}`);
    console.log(`${C.dim}You may need write permission to ${dir}, or try re-running the installer instead.${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.green}Updated 'cmt'${latestTag.length > 0 ? ` to ${latestTag}` : ''} -> ${currentPath}${C.reset}`);
}

// Main logic
async function main() {
  if (process.argv[2] === 'update') {
    await runSelfUpdate();
    process.exit(0);
  }

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

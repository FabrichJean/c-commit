import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Search for Claude Code configuration directories
export function locateClaudeCodeDir(): string | null {
  const home = os.homedir();

  const paths: string[] = [
    path.join(home, ".claude"),
    path.join(home, ".claude-code"),
  ];

  switch (process.platform) {
    case "linux":
      paths.push(path.join(home, ".config", "claude-code"));
      break;

    case "darwin":
      paths.push(
        path.join(home, "Library", "Application Support", "claude-code")
      );
      break;

    case "win32":
      paths.push(
        path.join(home, "AppData", "Roaming", "claude-code")
      );
      break;
  }

  return paths.find(fs.existsSync) ?? null;
}

// Encode an absolute project path the same way Claude Code does for ~/.claude/projects/<encoded>
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface SessionSummary {
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
export function findProjectSessions(projDir: string): { claudeHome: string | null; sessionDir: string | null; summaries: SessionSummary[] } {
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

export interface FileChange {
  file: string;
  tool: string;
  detail: string;
  timestamp: string;
}

// Pull the real file modifications (Edit/Write/MultiEdit/NotebookEdit tool calls) out of one or more sessions
export function extractFileChanges(sessionFilePaths: string[]): FileChange[] {
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
export function groupChangesByFile(changes: FileChange[], baseDir: string): { file: string; tools: string[]; count: number }[] {
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

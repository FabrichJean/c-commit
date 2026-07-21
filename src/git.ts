import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { C } from './ui/colors';
import { question } from './ui/prompt';

// Check if Git is initialized in the given directory
export const isGitRepo = (dir: string): boolean => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Read the local (falling back to global) Git author identity, "Name <email>"
export const getGitAuthor = (dir: string): string => {
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
export const getLastCommitDate = (dir: string): Date | null => {
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
export const offerGitInitIfNeeded = async (projDir: string, gitAuthor: string): Promise<void> => {
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
export const resolvePath = (input: string): string => {
  let p = input.trim();
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
};

// Read a file's content, tolerating files that no longer exist
export function readFileContentSafe(filePath: string): string | null {
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
export function isBinaryContent(content: string): boolean {
  return content.includes('\0');
}

// Read a file's content as it was in the last commit (HEAD), tolerating new/untracked files
export function getGitHeadContent(projDir: string, relFile: string): string | null {
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
export function getUntrackedFiles(projDir: string): string[] {
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

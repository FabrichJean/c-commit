import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { diffLines } from 'diff';
import { readFileContentSafe, isBinaryContent, getGitHeadContent, getUntrackedFiles } from './git';
import { groupChangesByFile, type FileChange } from './claude-sessions';

export interface CommitUnit {
  file: string;         // path relative to the project dir
  absPath: string;      // absolute path on disk
  before: string;       // content right before this transition (for further line-level splitting)
  content: string | null; // real file content at this point in history, or null if this step deletes the file
  time: Date;
}

// Build commit units directly from whatever is currently sitting in the working tree - modified,
// staged, or untracked files per `git status` - with no Claude Code session involved at all.
// Each unit diffs the file's current content against HEAD (or against '' for new/untracked
// files), so this plugs into the same splitting/bucketing/apply pipeline as session-based units.
export function buildCommitUnitsFromGitDiff(projDir: string): CommitUnit[] {
  let statusOutput: string;
  try {
    // --untracked-files=all: without it, a brand-new untracked directory collapses to a single
    // "?? some-dir/" line instead of listing the files inside it - that line then fails to read
    // as a file (EISDIR) and gets silently dropped, making a real new directory invisible here.
    statusOutput = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projDir, stdio: 'pipe' }).toString();
  } catch {
    return [];
  }

  const units: CommitUnit[] = [];

  for (const line of statusOutput.split('\n')) {
    if (!line.trim()) continue;
    const statusCode = line.slice(0, 2);

    let relFile = line.slice(3).trim();
    if (relFile.includes(' -> ')) relFile = relFile.split(' -> ')[1]; // renames: use the new path
    if (relFile.startsWith('"') && relFile.endsWith('"')) relFile = relFile.slice(1, -1);

    const absPath = path.join(projDir, relFile);

    if (statusCode.includes('D')) {
      // A deletion has no on-disk content to diff against, but it's still a real change that
      // needs to be committed (git rm, effectively) - dropping it here would leave the file
      // deleted-but-uncommitted in the working tree after apply, with the rest of the plan
      // committed around it.
      const before = getGitHeadContent(projDir, relFile) ?? '';
      if (before.length === 0) continue; // nothing meaningful to represent
      units.push({ file: relFile, absPath, before, content: null, time: new Date() });
      continue;
    }

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
export function summarizeDiffForPrompt(before: string, after: string | null, maxLines: number = 4): string {
  const afterText = after ?? '';
  if (before === afterText) return '';
  const parts = diffLines(before, afterText);
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
export function buildCommitUnits(sessionFilePaths: string[], claudeHome: string | null, projDir: string, fallbackChanges: FileChange[]): { units: CommitUnit[]; untrackedCount: number } {
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
    } else if (current === null && list[list.length - 1].content.length > 0) {
      // The file existed earlier in the session but has since been deleted from disk (e.g. via
      // a Bash `rm`) - represent that as a real deletion instead of silently dropping it.
      units.push({ file: relFile, absPath, before: list[list.length - 1].content, content: null, time: new Date() });
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
    if (current !== null && isBinaryContent(current)) continue;
    const before = getGitHeadContent(projDir, g.file) ?? '';
    // The tool touched this file but it's gone from disk now - only worth a deletion unit if it
    // actually existed in HEAD; otherwise there's nothing real to commit.
    if (current === null && before.length === 0) continue;
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
export function expandUnitsToCount(units: CommitUnit[], targetCount: number): CommitUnit[] {
  if (units.length === 0 || units.length >= targetCount) return units;

  // Deletions are atomic - splitting one into "partially deleted" intermediate commits doesn't
  // make sense, so they're never expanded (capacity 0).
  const capacities = units.map(u => u.content === null || u.before === u.content ? 0 : buildMicroSteps(u.before, u.content).filter(s => s.kind === 'change').length);
  const totalCapacity = capacities.reduce((a, b) => a + b, 0);
  if (totalCapacity <= units.length) return units;

  const desiredExtra = targetCount - units.length;
  const result: CommitUnit[] = [];

  units.forEach((u, idx) => {
    if (u.content === null) {
      result.push(u);
      return;
    }
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
export function chunkUnitsIntoCommits(units: CommitUnit[], count: number): CommitUnit[][] {
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

// Whether `relFile` is still present in Git's index right now - regardless of whether it also
// exists on disk. Used to detect deletions that have already been resolved by the time apply
// runs (e.g. committed by another process in the same repo between plan generation and the
// user confirming the apply prompt), so they can be skipped instead of failing `git add` with a
// confusing "pathspec did not match any files".
function isPathTracked(projDir: string, relFile: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relFile], { cwd: projDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Parse a commit's stored timestamp into an ISO 8601 string Git will accept for
// GIT_AUTHOR_DATE/GIT_COMMITTER_DATE, or null if it can't be parsed
function toGitDate(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Write each bucket's real historical file content, commit it, and move on - reconstructing the
// actual progression of the work. Every touched file is guaranteed to be left at its true current
// content on disk when this returns, even if a commit fails partway through.
export function applyCommitUnits(commits: any[], unitBuckets: CommitUnit[][], projDir: string): { applied: number; errors: string[] } {
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
          const relFile = path.relative(projDir, u.absPath);
          if (u.content === null) {
            // A deletion step - remove the file so `git add` below stages its absence. But the
            // Git state can shift between plan generation and this apply step (another process
            // committing in the same repo, or the user doing so manually while the confirmation
            // prompt was waiting) - if the path is no longer tracked at all, the deletion is
            // already resolved and there's nothing left to stage for it.
            if (!isPathTracked(projDir, relFile)) continue;
            try { fs.unlinkSync(u.absPath); } catch {}
          } else {
            fs.writeFileSync(u.absPath, u.content, 'utf-8');
          }
          files.push(relFile);
        }

        if (files.length === 0) {
          errors.push(`Commit #${i + 1}: all changes were already applied upstream, skipped.`);
          continue;
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

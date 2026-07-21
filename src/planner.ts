import * as fs from 'fs';
import * as path from 'path';
import { C } from './ui/colors';
import { question, selectOption } from './ui/prompt';
import { advanceRows, eraseRows } from './ui/terminal';
import { resolvePath, getGitAuthor, getLastCommitDate, offerGitInitIfNeeded, isGitRepo } from './git';
import { findProjectSessions, extractFileChanges, type FileChange } from './claude-sessions';
import {
  type CommitUnit,
  buildCommitUnitsFromGitDiff,
  buildCommitUnits,
  expandUnitsToCount,
  chunkUnitsIntoCommits,
  summarizeDiffForPrompt,
  applyCommitUnits,
} from './commit-units';
import { isClaudeCliAvailable, runClaudeCliStreaming } from './claude-cli';
import { generateProceduralCommits, generateProceduralCommitsFromUnits } from './procedural';

// Interactive commit-timeline planner: pick a project, ground it in real Claude Code
// session data (optional), generate a commit plan, and optionally apply it as real commits.
export async function runCommitPlanner() {
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

  let useRealDates = false;
  if (unitBuckets.length > 0) {
    console.log();
    const dateModeIndex = await selectOption('How should commit dates be set?', [
      'Match the real file change times (recommended)',
      `Spread evenly across the last ${days} day(s)`
    ]);
    useRealDates = dateModeIndex === 0;
  }

  console.log(`\n${C.dim}Generating a ${effectiveCount}-commit plan ${useRealDates ? 'using real file change dates' : `spanning ${days} day(s)`} for "${projName}"...${C.reset}`);
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

  // Real file-change times can predate the repo's last commit (e.g. a file touched a while ago
  // but never committed) or land in the future (clock skew, a `touch` with a bad date). Clamp to
  // [last commit date, now] so applied history stays chronologically sane either way.
  const lastCommitDate = useRealDates ? getLastCommitDate(projDir) : null;
  const now = Date.now();

  commits = commits.map((c: any, i: number) => {
    let realTime = useRealDates ? unitBuckets[i]?.[unitBuckets[i].length - 1]?.time : undefined;
    if (realTime !== undefined) {
      let t = realTime.getTime();
      if (lastCommitDate !== null) t = Math.max(t, lastCommitDate.getTime());
      t = Math.min(t, now);
      realTime = new Date(t);
    }
    return {
      ...c,
      author: gitAuthor,
      timestamp: realTime !== undefined ? realTime.toISOString() : c.timestamp
    };
  });

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

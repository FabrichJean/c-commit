import { type CommitUnit, summarizeDiffForPrompt } from './commit-units';

// Generate high fidelity procedural fallback commits
export function generateProceduralCommits(count: number, projectName: string) {
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
export function generateProceduralCommitsFromUnits(unitBuckets: CommitUnit[][], projectName: string) {
  const commits: any[] = [];
  const start = Date.now() - unitBuckets.length * 24 * 60 * 60 * 1000;

  unitBuckets.forEach((bucket, i) => {
    const files = Array.from(new Set(bucket.map(u => u.file)));
    const timestamp = new Date(start + i * 24 * 60 * 60 * 1000).toISOString();
    const hash = Math.random().toString(16).substring(2, 9);
    const label = files.length === 1 ? files[0] : `${files.length} files`;

    // Describe THIS bucket's own subdivision, not just "a change happened" - each bucket can be
    // a different slice of the same file's diff (from expandUnitsToCount), so without this the
    // body text would be identical across every commit for that file.
    const excerpt = bucket
      .map(u => summarizeDiffForPrompt(u.before, u.content, 6))
      .filter(Boolean)
      .join('\n');

    const body = excerpt.length > 0
      ? `Reconstructed from ${bucket.length} real change(s) to ${files.join(', ')} in ${projectName}:\n${excerpt}`
      : `Reconstructed from ${bucket.length} real change(s) to ${files.join(', ')} in ${projectName}.`;

    commits.push({
      hash,
      subject: `chore: update ${label}`,
      body,
      timestamp,
      author: "Claude Code <claude@anthropic.com>"
    });
  });
  return commits;
}

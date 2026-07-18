// Bumps package.json, commits it, and creates the matching git tag in one atomic step - a tag
// created separately from a stale package.json would ship a binary that misreports its own
// version (cmt --version / cmt update rely on __CMT_VERSION__, embedded from package.json at
// build time - see scripts/build-cli.mjs). Does NOT push: prints the push command instead, since
// pushing a tag triggers the real release workflow and should stay a deliberate, separate step.
//
// Usage: npm run release -- 0.1.6
//        npm run release -- patch|minor|major
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

const bump = process.argv[2];
if (!bump) {
  console.error('Usage: npm run release -- <version|patch|minor|major>');
  process.exit(1);
}

function run(cmd) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch {
    // The failing command already printed its own error to stderr (stdio: 'inherit') - no need
    // to also dump a Node stack trace on top of it.
    process.exit(1);
  }
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

const status = runCapture('git status --porcelain');
if (status.length > 0) {
  console.error('Working tree is not clean - commit or stash your changes first.');
  process.exit(1);
}

const branch = runCapture('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') {
  console.error(`You're on '${branch}', not 'main' - switch branches before releasing.`);
  process.exit(1);
}

// --no-git-tag-version: we commit + tag ourselves below, together with package-lock.json.
run(`npm version ${bump} --no-git-tag-version`);

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const tag = `v${pkg.version}`;

const existingTags = runCapture('git tag --list').split('\n');
if (existingTags.includes(tag)) {
  console.error(`Tag ${tag} already exists - aborting (package.json was already bumped, revert it manually if needed).`);
  process.exit(1);
}

const filesToAdd = ['package.json'];
if (existsSync('package-lock.json')) filesToAdd.push('package-lock.json');

run(`git add ${filesToAdd.join(' ')}`);
run(`git commit -m "chore: release ${tag}"`);
run(`git tag ${tag}`);

console.log('');
console.log(`Bumped to ${pkg.version} and tagged ${tag} locally.`);
console.log('Push when ready to trigger the release workflow:');
console.log('');
console.log(`  git push origin ${branch} ${tag}`);
console.log('');

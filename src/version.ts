import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// __CMT_VERSION__ is substituted at build time by scripts/build-cli.mjs (esbuild `define`) with
// package.json's version - the compiled binary embeds it, so `cmt --version` and `cmt update`'s
// up-to-date check don't need package.json to exist at runtime. Running from source via tsx
// skips that substitution, so fall back to reading package.json directly off disk there.
function resolveVersion(): string {
  if (typeof __CMT_VERSION__ === 'string') return __CMT_VERSION__;
  try {
    // tsx runs this file as ESM, where __dirname isn't reliably the file's real directory -
    // import.meta.url is. Only reached in dev mode; the compiled binary always has
    // __CMT_VERSION__ defined and never executes this branch.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export const CMT_VERSION = resolveVersion();

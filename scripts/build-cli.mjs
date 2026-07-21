// Bundles src/main.ts into dist/cli.cjs, embedding package.json's version as a compile-time
// constant (__CMT_VERSION__) so the compiled `cmt` binary can report/compare its own version
// (`cmt --version`, `cmt update`'s "already up to date" check) without needing package.json to
// be present at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));

await build({
  entryPoints: [path.join(rootDir, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(rootDir, 'dist/cli.cjs'),
  define: {
    __CMT_VERSION__: JSON.stringify(pkg.version),
  },
});

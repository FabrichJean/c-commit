// Injected at build time by scripts/build-cli.mjs (esbuild `define`). Undefined when running
// from source via tsx, where cli.ts falls back to reading package.json directly.
declare const __CMT_VERSION__: string | undefined;

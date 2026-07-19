import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { C } from './ui/colors';
import { CMT_VERSION } from './version';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Streams the response body, rendering a live progress bar (or, on non-TTY output, periodic
// percentage lines) so `cmt update` doesn't sit silently for the several seconds a ~15-20MB
// compressed asset takes to fetch.
export async function downloadWithProgress(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const isTTY = !!process.stdout.isTTY;
  const barWidth = 28;
  const chunks: Buffer[] = [];
  let received = 0;
  let lastPercent = -1;

  const reader = (res.body as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    received += chunk.length;

    if (total > 0) {
      const percent = Math.min(100, Math.round((received / total) * 100));
      if (isTTY) {
        const filled = Math.round((percent / 100) * barWidth);
        const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
        process.stdout.write(`\r${C.dim}${label} [${C.theme}${bar}${C.dim}] ${percent}% (${formatBytes(received)}/${formatBytes(total)})${C.reset}  `);
      } else if (percent >= lastPercent + 10) {
        lastPercent = percent;
        console.log(`${C.dim}${label}: ${percent}% (${formatBytes(received)}/${formatBytes(total)})${C.reset}`);
      }
    } else if (isTTY) {
      process.stdout.write(`\r${C.dim}${label}: ${formatBytes(received)}...${C.reset}  `);
    }
  }
  if (isTTY) process.stdout.write('\n');
  return Buffer.concat(chunks);
}

// Release assets are published compressed (.gz on macOS/Linux, .zip on Windows) - `tar` handles
// both without adding a dependency and ships on every platform we target (including Windows 10
// 1803+ / Windows 11, which bundle bsdtar as tar.exe).
function extractSingleFileFromZip(zipBytes: Buffer, fileName: string): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-update-'));
  const zipPath = path.join(tmpDir, 'asset.zip');
  try {
    fs.writeFileSync(zipPath, zipBytes);
    execFileSync('tar', ['-xf', zipPath, '-C', tmpDir], { stdio: 'pipe' });
    return fs.readFileSync(path.join(tmpDir, fileName));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Download the latest release for this platform and replace the currently running binary with
// it. Only meaningful when running as the compiled `cmt` executable (pkg sets `process.pkg`) -
// running this from source (tsx) would otherwise try to overwrite the system node/tsx binary.
export async function runSelfUpdate(): Promise<void> {
  const REPO_SLUG = 'FabrichJean/c-commit';

  if (!(process as any).pkg) {
    console.log(`${C.yellow}'cmt update' only works in the compiled binary, not when running from source.${C.reset}`);
    console.log(`${C.dim}From a clone, use 'git pull' instead.${C.reset}`);
    process.exit(1);
  }

  let asset: string | null = null;
  let compressedExt: '.gz' | '.zip' = '.gz';
  if (process.platform === 'darwin') {
    asset = process.arch === 'arm64' ? 'commit-planner-macos-arm64' : process.arch === 'x64' ? 'commit-planner-macos-x64' : null;
    compressedExt = '.gz';
  } else if (process.platform === 'linux') {
    asset = process.arch === 'x64' ? 'commit-planner-linux-x64' : null;
    compressedExt = '.gz';
  } else if (process.platform === 'win32') {
    asset = process.arch === 'x64' ? 'commit-planner-win-x64.exe' : null;
    compressedExt = '.zip';
  }

  if (!asset) {
    console.log(`${C.red}Unsupported platform for self-update: ${process.platform}/${process.arch}${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.dim}[1/4] Checking the latest release of ${REPO_SLUG}...${C.reset}`);

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

  const latestVersion = latestTag.replace(/^v/, '');
  if (latestVersion.length > 0 && latestVersion === CMT_VERSION) {
    console.log(`${C.green}Already up to date (v${CMT_VERSION}).${C.reset}`);
    return;
  }

  const compressedAsset = `${asset}${compressedExt}`;
  const downloadUrl = `https://github.com/${REPO_SLUG}/releases/latest/download/${compressedAsset}`;
  console.log(`${C.dim}[2/4] Downloading ${compressedAsset}${latestTag.length > 0 ? ` (${latestTag})` : ''}...${C.reset}`);

  let compressedBytes: Buffer;
  try {
    compressedBytes = await downloadWithProgress(downloadUrl, 'Downloading');
  } catch (err: any) {
    console.log(`${C.red}Download failed: ${err.message}${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.dim}[3/4] Extracting...${C.reset}`);

  let bytes: Buffer;
  try {
    bytes = compressedExt === '.gz' ? zlib.gunzipSync(compressedBytes) : extractSingleFileFromZip(compressedBytes, asset);
  } catch (err: any) {
    console.log(`${C.red}Failed to extract the downloaded archive: ${err.message}${C.reset}`);
    process.exit(1);
  }

  const currentPath = process.execPath;
  const dir = path.dirname(currentPath);
  const tempPath = path.join(dir, `.${path.basename(currentPath)}.new`);

  console.log(`${C.dim}[4/4] Installing...${C.reset}`);

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

  console.log(`${C.green}Updated 'cmt' v${CMT_VERSION}${latestTag.length > 0 ? ` -> ${latestTag}` : ''} (${currentPath})${C.reset}`);
}

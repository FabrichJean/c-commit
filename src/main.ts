import * as fs from 'fs';
import * as path from 'path';
import { C, clearScreen } from './ui/colors';
import { rl, question } from './ui/prompt';
import { printBanner } from './ui/banner';
import { CMT_VERSION } from './version';
import { runSelfUpdate } from './self-update';
import { runCommitPlanner } from './planner';

async function main() {
  if (process.argv[2] === '--version' || process.argv[2] === '-v' || process.argv[2] === 'version') {
    console.log(`cmt v${CMT_VERSION}`);
    process.exit(0);
  }

  if (process.argv[2] === 'update' || process.argv[2] === '--update' || process.argv[2] === '-u' || process.argv[2] === 'upgrade' || process.argv[2] === '--upgrade') {
    await runSelfUpdate();
    process.exit(0);
  }

  // Load environment variables from local .env if available
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[key] = value;
      }
    });
  }

  clearScreen();
  printBanner();

  let again = true;
  while (again) {
    await runCommitPlanner();
    const rawAgain = await question(`\n${C.dim}Generate another commit plan? (y/N): ${C.reset}`);
    again = rawAgain.trim().toLowerCase() === 'y';
    if (again) {
      clearScreen();
      printBanner();
    }
  }

  console.log(`\n${C.dim}Goodbye.${C.reset}`);
  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error("CLI Execution failed:", err);
  process.exit(1);
});

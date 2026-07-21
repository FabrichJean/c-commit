import { C } from './colors';
import { isClaudeCliAvailable } from '../claude-cli';

// Length of a string as it will actually appear on screen, ignoring ANSI escape codes
function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Truncate plain (uncolored) text to fit a visible-column budget, with an ellipsis if cut
function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  return text.slice(0, maxWidth - 1) + '…';
}

// A small bracketed status badge, e.g. "[ CONNECTED ]"
function badge(text: string, color: string): string {
  return `${color}${C.bold}[ ${text} ]${C.reset}`;
}

// Wrap plain text into lines that each fit within `maxWidth` visible columns
function wrapToWidth(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length > maxWidth) {
      lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Print a double-bordered banner with a status section, in the global theme (no emoji).
// Sizes itself to the current terminal width, and drops the border entirely below a
// minimum width where a box would just look broken.
export function printBanner() {
  const termWidth = process.stdout.columns || 80;

  const claudeCliPath = isClaudeCliAvailable();
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.GEMINI_API_KEY;

  const cliBadge = claudeCliPath ? badge('CONNECTED', C.green) : badge('NOT FOUND', C.yellow);
  const credBadge = apiKey ? badge('CONFIGURED', C.green) : badge('NOT SET', C.yellow);
  const cliDetail = claudeCliPath || 'not found on PATH';
  const credDetail = apiKey ? '' : 'procedural fallback ready';

  const MIN_BOX_WIDTH = 44;

  if (termWidth < MIN_BOX_WIDTH) {
    // Too narrow for a readable box - plain stacked lines instead
    console.log(`${C.themeVivid}${C.bold}Claude Commit Planner${C.reset}`);
    wrapToWidth('Generate and apply Git commit plans grounded in real Claude Code session history.', termWidth)
      .forEach(l => console.log(`${C.dim}${l}${C.reset}`));
    console.log();
    console.log(`${C.dim}Claude Code CLI${C.reset} ${cliBadge}`);
    console.log(`  ${C.dim}${truncateToWidth(cliDetail, Math.max(termWidth - 2, 4))}${C.reset}`);
    console.log(`${C.dim}Credentials${C.reset} ${credBadge}`);
    if (credDetail) console.log(`  ${C.dim}${truncateToWidth(credDetail, Math.max(termWidth - 2, 4))}${C.reset}`);
    console.log();
    return;
  }

  const width = Math.min(78, termWidth - 2);
  const innerWidth = width - 4;

  const titleLine = `${C.themeVivid}${C.bold}Claude Commit Planner${C.reset}`;
  const subtitleLines = wrapToWidth('Generate and apply Git commit plans grounded in real Claude Code session history.', innerWidth)
    .map(l => `${C.dim}${l}${C.reset}`);

  const statusRow = (label: string, statusBadge: string, detail: string) => {
    const labelPart = `${C.dim}${label.padEnd(16)}${C.reset}`;
    const usedWidth = visibleLength(labelPart) + 1 + visibleLength(statusBadge) + (detail ? 2 : 0);
    const detailBudget = Math.max(innerWidth - usedWidth, 0);
    const truncatedDetail = truncateToWidth(detail, detailBudget);
    const detailPart = truncatedDetail ? `  ${C.dim}${truncatedDetail}${C.reset}` : '';
    return `${labelPart} ${statusBadge}${detailPart}`;
  };

  const statusLines = [
    statusRow('Claude Code CLI', cliBadge, cliDetail),
    statusRow('Credentials', credBadge, credDetail),
  ];

  const printRow = (content: string) => {
    const padding = ' '.repeat(Math.max(innerWidth - visibleLength(content), 0));
    console.log(`${C.theme}║${C.reset} ${content}${padding} ${C.theme}║${C.reset}`);
  };

  console.log(`${C.theme}╔${'═'.repeat(width - 2)}╗${C.reset}`);
  [titleLine, '', ...subtitleLines].forEach(printRow);
  console.log(`${C.theme}╠${'═'.repeat(width - 2)}╣${C.reset}`);
  statusLines.forEach(printRow);
  console.log(`${C.theme}╚${'═'.repeat(width - 2)}╝${C.reset}`);
  console.log();
}

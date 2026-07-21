// Track how many terminal rows a chunk of text advances the cursor by, accounting for line wraps.
// Uses relative cursor movement math (not absolute save/restore) so it stays correct even if the
// terminal scrolls while long content streams in.
export function advanceRows(text: string, startCol: number, terminalWidth: number): { rows: number; endCol: number } {
  let col = startCol;
  let rows = 0;
  for (const ch of text) {
    if (ch === '\n') {
      rows++;
      col = 0;
    } else {
      col++;
      if (col >= terminalWidth) {
        rows++;
        col = 0;
      }
    }
  }
  return { rows, endCol: col };
}

// Move the cursor back to the start of `rows` rows of previously-printed output and erase them
export function eraseRows(rows: number) {
  if (rows > 0) process.stdout.write(`\x1b[${rows}A`);
  process.stdout.write('\r\x1b[0J');
}

// 24-bit true-color helper, for exact hex theme colors
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

// ANSI escape codes for styling
export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  white: '\x1b[37m',

  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightWhite: '\x1b[97m',

  // Global theme, anchored on #285669
  theme: rgb(40, 86, 105),        // #285669 - structural (borders, secondary labels)
  themeVivid: rgb(57, 168, 213),  // vivid, more saturated/brighter version of the same hue - accents, titles
};

// Clear screen and reset cursor position
export const clearScreen = () => {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
};

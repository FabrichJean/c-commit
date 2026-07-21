import * as readline from 'readline';
import { C } from './colors';
import { eraseRows } from './terminal';

export const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

export const question = (query: string): Promise<string> => {
  return new Promise((resolve) => rl.question(query, resolve));
};

// Arrow-key navigable option picker: up/down to move, Enter to confirm, Ctrl+C to exit.
// Falls back to returning the first option immediately when stdin isn't a real TTY.
export function selectOption(promptText: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.log(`${C.bold}${promptText}${C.reset} ${C.themeVivid}${options[0]}${C.reset}`);
      resolve(0);
      return;
    }

    let selected = 0;

    const renderOptions = () => {
      options.forEach((opt, i) => {
        const isSelected = i === selected;
        const marker = isSelected ? `${C.themeVivid}${C.bold}>${C.reset}` : ' ';
        const label = isSelected ? `${C.themeVivid}${opt}${C.reset}` : `${C.dim}${opt}${C.reset}`;
        console.log(` ${marker} ${label}`);
      });
    };

    console.log(`${C.bold}${promptText}${C.reset} ${C.dim}(use arrow keys, Enter to confirm)${C.reset}`);
    renderOptions();

    const onKeypress = (_str: string, key: any) => {
      if (!key) return;
      if (key.name === 'up') {
        selected = (selected - 1 + options.length) % options.length;
        eraseRows(options.length);
        renderOptions();
      } else if (key.name === 'down') {
        selected = (selected + 1) % options.length;
        eraseRows(options.length);
        renderOptions();
      } else if (key.name === 'return') {
        eraseRows(options.length + 1);
        console.log(`${C.bold}${promptText}${C.reset} ${C.themeVivid}${options[selected]}${C.reset}`);
        cleanup();
        resolve(selected);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log(`\n${C.dim}Goodbye.${C.reset}`);
        process.exit(0);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rl.resume();
    };

    rl.pause();
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKeypress);
    process.stdin.resume();
  });
}

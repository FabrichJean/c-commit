import { execSync, spawn } from 'child_process';

// Check whether the local `claude` executable (Claude Code CLI) is installed and on PATH
export function isClaudeCliAvailable(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const p = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\n')[0];
    return p || null;
  } catch {
    return null;
  }
}

// Run the local Claude Code CLI in streaming mode, printing its output live as it's generated
export function runClaudeCliStreaming(prompt: string, cwd: string, onText: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // This is a one-shot text task (write commit messages, return JSON) - no tools, MCP servers,
    // or Claude Code's full default system prompt are needed. Without these flags, every call
    // pays ~10-30k tokens of fixed agentic overhead (tool definitions, memory, skills) before a
    // single token of actual work; with them, that drops to a few hundred.
    const child = spawn('claude', [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--tools', '',
      '--strict-mcp-config',
      '--system-prompt', 'You are a git commit message writer. You do not use any tools. Respond only with the exact output format requested, with no preamble, explanation, or commentary.'
    ], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buffer = '';
    let finalResult = '';
    let errOutput = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
            onText(event.event.delta.text);
          } else if (event.type === 'result') {
            finalResult = event.result ?? '';
          }
        } catch {
          // Skip malformed / partial JSON lines
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      errOutput += chunk.toString('utf-8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !finalResult) {
        reject(new Error(errOutput.trim() || `claude exited with code ${code}`));
      } else {
        resolve(finalResult);
      }
    });
  });
}

import { spawn } from 'child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface RunAgentOptions {
  workspaceDir: string;
  prompt: string;
}

export function runClaudeAgent(opts: RunAgentOptions): Promise<void> {
  const { workspaceDir, prompt } = opts;

  return new Promise((resolve, reject) => {
    const log = logger.child({ workspaceDir });

    log.info('Spawning Claude Code CLI');

    const child = spawn(
      'claude',
      [
        '--print',             // non-interactive mode
        '--allowedTools', 'all', // allow all tools including MCP
        '--dangerously-skip-permissions', // run without confirmation prompts
        prompt,
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
          GITHUB_TOKEN: config.GITHUB_TOKEN,
          // Disable any interactive TTY behaviour
          TERM: 'dumb',
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const timeout = setTimeout(() => {
      log.error('Claude Code timed out — killing process');
      child.kill('SIGKILL');
      reject(new Error(`Claude Code timed out after ${config.CLAUDE_TIMEOUT_MS}ms`));
    }, config.CLAUDE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        log.info('Claude Code exited successfully');
        resolve();
      } else {
        reject(new Error(`Claude Code exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

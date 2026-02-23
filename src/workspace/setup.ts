import fs from 'fs/promises';
import path from 'path';
import { simpleGit } from 'simple-git';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Resolve the repo URL for a given card.
// Convention: set a Trello custom field "GitHub Repo" on the card, OR
// include a line like "repo: https://github.com/org/name" anywhere in the description.
// Fall back to env var DEFAULT_GITHUB_REPO if set.
export function extractRepoUrl(cardDesc: string): string | null {
  const match = cardDesc.match(/repo:\s*(https?:\/\/github\.com\/[^\s]+)/i);
  if (match) return match[1].trim();
  return process.env.DEFAULT_GITHUB_REPO ?? null;
}

interface SetupOptions {
  workspaceDir: string;
  cardId: string;
  branchName: string;
  checkout?: boolean; // true = checkout existing branch, false = create new
  repoUrl?: string;   // if not provided, workspace must already exist
}

export async function setupWorkspace(opts: SetupOptions): Promise<void> {
  const { workspaceDir, branchName, checkout = false, repoUrl } = opts;

  await fs.mkdir(workspaceDir, { recursive: true });

  const git = simpleGit(workspaceDir);

  if (repoUrl) {
    logger.info({ repoUrl, workspaceDir }, 'Cloning repo');
    await simpleGit().clone(repoUrl, workspaceDir, ['--depth', '1']);
  }

  // Configure git identity for commits
  await git.addConfig('user.name', 'Claude SWE');
  await git.addConfig('user.email', 'claude-swe@noreply.example.com');

  // Embed token for push auth via HTTPS
  if (config.GITHUB_TOKEN) {
    const remote = (await git.remote(['get-url', 'origin'])) ?? '';
    const authedRemote = remote
      .trim()
      .replace('https://', `https://oauth2:${config.GITHUB_TOKEN}@`);
    await git.remote(['set-url', 'origin', authedRemote]);
  }

  if (checkout) {
    // Pull the existing remote branch
    await git.fetch('origin', branchName);
    await git.checkout(['-B', branchName, `origin/${branchName}`]);
  } else {
    // Create a fresh feature branch
    await git.checkoutLocalBranch(branchName);
  }

  // Write .claude/settings.local.json with MCP server configs
  await writeMcpConfig(workspaceDir);

  logger.info({ workspaceDir, branchName }, 'Workspace ready');
}

async function writeMcpConfig(workspaceDir: string): Promise<void> {
  const claudeDir = path.join(workspaceDir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const trelloServerPath = path.resolve('/app/mcp/trello-server/dist/index.js');

  const settings = {
    mcpServers: {
      trello: {
        command: 'node',
        args: [trelloServerPath],
        env: {
          TRELLO_API_KEY: config.TRELLO_API_KEY,
          TRELLO_TOKEN: config.TRELLO_TOKEN,
          TRELLO_DONE_LIST_ID: config.TRELLO_DONE_LIST_ID,
        },
      },
      playwright: {
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless'],
      },
    },
  };

  await fs.writeFile(
    path.join(claudeDir, 'settings.local.json'),
    JSON.stringify(settings, null, 2),
  );
}

export async function cleanupWorkspace(workspaceDir: string): Promise<void> {
  await fs.rm(workspaceDir, { recursive: true, force: true });
  logger.info({ workspaceDir }, 'Workspace cleaned up');
}

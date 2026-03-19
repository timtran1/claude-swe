import { getBoardConfig, config } from '../config.js';

/**
 * Get the list of configured repos for a board.
 * These are advisory hints — Claude decides which repo to actually clone.
 */
export function getBoardRepos(boardId: string): string[] {
  return getBoardConfig(boardId)?.repos ?? [];
}

/**
 * Get the list of configured repos for a Jira project key.
 * Returns an empty array when no per-project config exists (global bot mode
 * resolves repos from the issue description at enqueue time, not here).
 */
export function getJiraProjectRepos(projectKey: string): string[] {
  return config.jira.projects.find((p) => p.key === projectKey)?.repos ?? [];
}

/**
 * Get all unique repo slugs (owner/repo) across all configured boards and Jira projects.
 * Used by cleanup to check for open PRs across all possible repos.
 */
export function getAllRepoSlugs(): string[] {
  const seen = new Set<string>();

  for (const board of config.trello.boards) {
    for (const repoUrl of board.repos) {
      try {
        const url = new URL(repoUrl);
        const slug = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
        if (slug) seen.add(slug);
      } catch {
        // ignore malformed URLs
      }
    }
  }

  for (const project of config.jira.projects) {
    for (const repoUrl of project.repos) {
      try {
        const url = new URL(repoUrl);
        const slug = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
        if (slug) seen.add(slug);
      } catch {
        // ignore malformed URLs
      }
    }
  }

  return [...seen];
}

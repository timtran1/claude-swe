import { config } from '../config.js';
import type { JiraProjectConfig } from '../config.js';
import { adfToText } from './adf.js';

/** Effective Jira config resolved for a specific issue — used by webhook handler and worker */
export interface ResolvedJiraConfig {
  repos: string[];
  doing: { statusId?: string; status?: string } | null;
  done: { statusId?: string; status?: string } | null;
  /** Empty array means all statuses are allowed */
  includeStatuses: string[];
}

/**
 * Extract repo URLs from a Jira issue description (ADF format).
 * Walks the ADF tree to find all text, then applies pattern: repo: <url>
 * Returns an empty array for null/undefined descriptions.
 */
export function extractReposFromDescription(description: unknown): string[] {
  if (!description) return [];
  const text = adfToText(description);
  const matches = text.matchAll(/repo:\s*(https?:\/\/\S+)/gi);
  const repos: string[] = [];
  for (const match of matches) {
    repos.push(match[1].replace(/[.,;)]+$/, '')); // strip trailing punctuation
  }
  return repos;
}

/**
 * Merge two repo arrays, deduplicating by URL.
 * Primary repos come first; secondary repos are appended if not already present.
 */
function mergeRepos(primary: string[], secondary: string[]): string[] {
  const seen = new Set(primary);
  const result = [...primary];
  for (const repo of secondary) {
    if (!seen.has(repo)) {
      seen.add(repo);
      result.push(repo);
    }
  }
  return result;
}

/**
 * Resolve the effective Jira config for a given project key and issue description.
 *
 * Priority order:
 * 1. Per-project config (from jira.projects[]) — repos merged with description-extracted repos
 * 2. Global bot mode — repos from description only, global doing/done transitions
 *
 * Returns null if Jira is not configured (no host/email/apiToken).
 */
export function resolveJiraConfig(projectKey: string, description: unknown): ResolvedJiraConfig {
  const descriptionRepos = extractReposFromDescription(description);
  const projectConfig: JiraProjectConfig | undefined = config.jira.projects.find(
    (p) => p.key === projectKey,
  );

  if (projectConfig) {
    // Per-project config found — merge repos (per-project takes priority)
    return {
      repos: mergeRepos(projectConfig.repos, descriptionRepos),
      doing: projectConfig.doing ?? config.jira.doing,
      done: projectConfig.done ?? config.jira.done,
      includeStatuses: projectConfig.includeStatuses,
    };
  }

  // Global bot mode — no per-project config
  return {
    repos: descriptionRepos,
    doing: config.jira.doing,
    done: config.jira.done,
    includeStatuses: [],
  };
}

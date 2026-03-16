import { config } from '../config.js';
import { logger } from '../logger.js';

export interface RepoAccessResult {
  url: string;
  /** true = token has push access and the repo exists */
  accessible: boolean;
  /** Human-readable reason when accessible is false */
  reason: string;
  /** Suggested fix shown to the user */
  fix: string;
}

/**
 * Extract owner/repo slug from a GitHub URL.
 * Returns null for non-GitHub URLs.
 */
function parseGithubSlug(url: string): string | null {
  const match = url.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

/**
 * Check whether the configured GITHUB_TOKEN has push access to a single repo.
 */
async function checkOne(repoUrl: string): Promise<RepoAccessResult> {
  const slug = parseGithubSlug(repoUrl);
  if (!slug) {
    return {
      url: repoUrl,
      accessible: false,
      reason: `"${repoUrl}" is not a valid GitHub repository URL.`,
      fix: 'Use a URL in the form https://github.com/owner/repo',
    };
  }

  const token = config.github.token;
  if (!token) {
    return {
      url: repoUrl,
      accessible: false,
      reason: 'No GitHub token is configured (GITHUB_TOKEN is missing).',
      fix: 'Set GITHUB_TOKEN in your .env file and restart the server.',
    };
  }

  let status: number;
  let body: Record<string, unknown>;
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    status = res.status;
    body = status !== 204 ? (await res.json() as Record<string, unknown>) : {};
  } catch (err) {
    logger.warn({ err, repoUrl }, 'GitHub access check failed — network error');
    // Fail open: don't block the task on a transient network error
    return { url: repoUrl, accessible: true, reason: '', fix: '' };
  }

  if (status === 404) {
    return {
      url: repoUrl,
      accessible: false,
      reason: `Repository \`${slug}\` was not found, or the GitHub token does not have access to it.`,
      fix:
        `1. Confirm the URL is correct: ${repoUrl}\n` +
        `2. If the repo is private, make sure the GitHub token has access to it:\n` +
        `   - Fine-grained PAT: add the repo under "Repository access"\n` +
        `   - Classic PAT: ensure the \`repo\` scope is granted`,
    };
  }

  if (status === 403) {
    return {
      url: repoUrl,
      accessible: false,
      reason: `The GitHub token was rejected when accessing \`${slug}\` (403 Forbidden).`,
      fix:
        'The token may be expired or revoked. Generate a new token at:\n' +
        'https://github.com/settings/tokens',
    };
  }

  if (status !== 200) {
    // Unexpected status — fail open so we don't block legitimate tasks
    logger.warn({ status, repoUrl }, 'Unexpected status from GitHub access check — allowing task to proceed');
    return { url: repoUrl, accessible: true, reason: '', fix: '' };
  }

  // Repo exists — check push permission
  const permissions = body['permissions'] as Record<string, boolean> | undefined;
  const canPush = permissions?.push === true || permissions?.admin === true;

  if (!canPush) {
    return {
      url: repoUrl,
      accessible: false,
      reason: `The GitHub token can read \`${slug}\` but does not have **push** (write) access.`,
      fix:
        `The token needs write permission to create branches and pull requests:\n` +
        `- **Fine-grained PAT**: edit the token at https://github.com/settings/tokens, ` +
        `set **Contents → Read and write** and **Pull requests → Read and write** for this repo.\n` +
        `- **Classic PAT**: ensure the \`repo\` scope is granted (not just \`public_repo\`).`,
    };
  }

  return { url: repoUrl, accessible: true, reason: '', fix: '' };
}

/**
 * Check GitHub token access for every repo in the list.
 * Returns only the repos that are inaccessible (empty = all good).
 */
export async function checkRepoAccess(repoUrls: string[]): Promise<RepoAccessResult[]> {
  const results = await Promise.all(repoUrls.map(checkOne));
  return results.filter((r) => !r.accessible);
}

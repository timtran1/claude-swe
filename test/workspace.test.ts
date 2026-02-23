import { describe, it, expect } from 'vitest';
import { extractRepoUrl } from '../src/workspace/repo.js';

describe('extractRepoUrl', () => {
  it('extracts repo URL from card description', () => {
    const desc = `
## Task
Build a new dashboard

repo: https://github.com/myorg/my-app

## Acceptance Criteria
- Shows user metrics
    `;
    expect(extractRepoUrl(desc)).toBe('https://github.com/myorg/my-app');
  });

  it('handles case-insensitive repo prefix', () => {
    const desc = 'Repo: https://github.com/myorg/my-app';
    expect(extractRepoUrl(desc)).toBe('https://github.com/myorg/my-app');
  });

  it('returns null when no repo URL found', () => {
    const desc = 'Fix the login bug on the main page';
    // Also ensure DEFAULT_GITHUB_REPO is not set
    delete process.env.DEFAULT_GITHUB_REPO;
    expect(extractRepoUrl(desc)).toBeNull();
  });

  it('returns DEFAULT_GITHUB_REPO env var as fallback', () => {
    process.env.DEFAULT_GITHUB_REPO = 'https://github.com/myorg/default-repo';
    const desc = 'Fix the login bug';
    expect(extractRepoUrl(desc)).toBe('https://github.com/myorg/default-repo');
    delete process.env.DEFAULT_GITHUB_REPO;
  });
});

import { config } from '../config.js';
import { logger } from '../logger.js';
import { getJiraCurrentUser } from './api.js';

/** Resolved Jira account ID of the bot user. Null until initialized. */
export let jiraBotAccountId: string | null = null;

/**
 * Resolve and cache the bot's Jira account ID at startup.
 * Uses config.jira.botAccountId if already set, otherwise fetches from /myself.
 * Safe to call multiple times (idempotent). No-op if Jira is not configured.
 */
export async function initJiraBotAccountId(): Promise<void> {
  if (jiraBotAccountId) return;
  if (!config.jira.host || !config.jira.email || !config.jira.apiToken) return;

  // Use config value if explicitly set — avoids an API call at startup
  if (config.jira.botAccountId) {
    jiraBotAccountId = config.jira.botAccountId;
    logger.info({ jiraBotAccountId }, 'Using configured Jira bot account ID');
    return;
  }

  try {
    const user = await getJiraCurrentUser();
    jiraBotAccountId = user.accountId;
    logger.info({ jiraBotAccountId, displayName: user.displayName }, 'Resolved Jira bot account ID');
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve Jira bot account ID — assignee check will be skipped');
  }
}

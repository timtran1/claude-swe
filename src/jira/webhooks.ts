import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Log manual Jira webhook setup instructions at startup.
 *
 * Jira Cloud's dynamic webhook API (POST /rest/api/3/webhook) is restricted to
 * Connect and OAuth 2.0 apps — it cannot be used with Basic Auth (email + API token).
 * Auto-registration is therefore not possible for bot accounts.
 *
 * This function logs a one-time INFO message with the exact steps to register
 * the webhook manually via the Jira admin UI.
 */
export async function registerJiraWebhooks(): Promise<void> {
  const log = logger.child({ phase: 'jira-webhooks' });
  const { host, email, apiToken } = config.jira;
  const { webhookBaseUrl } = config.server;

  if (!host || !email || !apiToken) {
    log.debug('Jira not configured — skipping webhook setup check');
    return;
  }

  if (!webhookBaseUrl) {
    log.warn('webhookBaseUrl not set — cannot determine Jira webhook callback URL (set server.webhookBaseUrl in config)');
    return;
  }

  const callbackUrl = `${webhookBaseUrl}/webhooks/jira`;

  if (config.jira.webhookConfigured) {
    log.info({ callbackUrl }, 'Jira webhook already configured — skipping setup reminder');
    return;
  }

  log.info(
    { callbackUrl },
    'Jira webhook must be registered manually (Jira Cloud dynamic webhook API requires a Connect/OAuth 2.0 app).\n' +
    'One-time setup:\n' +
    `  1. Go to ${host}/plugins/servlet/webhooks\n` +
    `  2. Click "Create a WebHook"\n` +
    `  3. URL: ${callbackUrl}\n` +
    '  4. Events: check "Issue → updated", "Comment → created", "Issue → deleted"\n' +
    '  5. Save — no expiry, no API token required\n' +
    'After setup, set "jira": { "webhookConfigured": true } in config.json to suppress this message.',
  );
}

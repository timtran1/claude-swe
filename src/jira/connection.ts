import { config } from '../config.js';
import { logger } from '../logger.js';
import { getJiraCurrentUser, getJiraProjects, getJiraProjectStatuses } from './api.js';

/**
 * Verify Jira connectivity at startup. Logs:
 *   - Bot account (accountId, displayName, email)
 *   - All accessible projects (key + name)
 *   - Statuses for each explicitly configured project (jira.projects[])
 *
 * No-op if Jira is not configured. Logs a warning on failure — does not throw
 * so a misconfigured Jira integration never prevents the server from starting.
 */
export async function checkJiraConnection(): Promise<void> {
  if (!config.jira.host || !config.jira.email || !config.jira.apiToken) {
    logger.debug('Jira not configured — skipping connection check');
    return;
  }

  const log = logger.child({ phase: 'jira-connection' });

  // --- Account ---
  let account: { accountId: string; displayName: string; emailAddress: string };
  try {
    account = await getJiraCurrentUser();
  } catch (err) {
    log.warn({ err }, 'Jira connection check failed — verify host, email, and apiToken in config');
    return;
  }

  log.info(
    { accountId: account.accountId, displayName: account.displayName, email: account.emailAddress },
    'Jira connected',
  );

  // --- Accessible projects ---
  let projects: Array<{ id: string; key: string; name: string }>;
  try {
    projects = await getJiraProjects();
  } catch (err) {
    log.warn({ err }, 'Failed to fetch Jira project list');
    return;
  }

  log.info(
    { count: projects.length, projects: projects.map((p) => `${p.key} – ${p.name}`) },
    `Accessible Jira projects (${projects.length})`,
  );

  // --- Statuses for each explicitly configured project ---
  if (config.jira.projects.length === 0) return;

  for (const projectCfg of config.jira.projects) {
    const found = projects.find((p) => p.key === projectCfg.key);
    if (!found) {
      log.warn(
        { projectKey: projectCfg.key },
        `Configured project "${projectCfg.key}" not found in accessible projects — check the key or bot membership`,
      );
      continue;
    }

    try {
      const statuses = await getJiraProjectStatuses(projectCfg.key);
      log.info(
        {
          projectKey: projectCfg.key,
          projectName: found.name,
          statuses: statuses.map((s) => `${s.name} (id:${s.id})`),
        },
        `Project ${projectCfg.key} — ${statuses.length} statuses: ${statuses.map((s) => s.name).join(', ')}`,
      );
    } catch (err) {
      log.warn({ err, projectKey: projectCfg.key }, `Failed to fetch statuses for project ${projectCfg.key}`);
    }
  }
}

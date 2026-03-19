import express from 'express';
import { config, resolveNames } from './config.js';
import { logger } from './logger.js';
import { handleTrelloWebhook, handleGitHubWebhook } from './webhook/handler.js';
import { handleJiraWebhook } from './webhook/jira-handler.js';
import { listWorkerContainers } from './containers/manager.js';
import { gracefulShutdown } from './queue/worker.js';
import { initBotMemberId } from './trello/bot.js';
import { initJiraBotAccountId } from './jira/bot.js';
import { handleLogViewer, handleLogStream } from './logs/handler.js';
import { startSlack, isSlackConfigured } from './slack/client.js';
import { registerJiraWebhooks } from './jira/webhooks.js';

const app = express();

// Capture raw body before JSON parsing — needed for webhook signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody: Buffer }).rawBody = buf;
    },
  }),
);

// Health check — shows which integrations have credentials configured
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    boards: config.trello.boards.length,
    trello: config.trello.token !== null,
    github: config.github.token !== null,
    anthropic: config.anthropic.apiKey !== null,
    slack: isSlackConfigured(),
    jira: !!(config.jira.host && config.jira.email && config.jira.apiToken),
  });
});

// List active worker containers
app.get('/workers', async (_req, res) => {
  const containers = await listWorkerContainers();
  res.json(containers);
});

// Public log viewer — UUID token in URL acts as auth
app.get('/logs/:token', handleLogViewer);
app.get('/logs/:token/stream', handleLogStream);

// Trello webhook — handle both HEAD (verification) and POST (events)
app.all('/webhooks/trello', handleTrelloWebhook);

// GitHub webhook — handles PR closed → container cleanup
app.post('/webhooks/github', handleGitHubWebhook);

// Jira webhook — handles issue assignment, comments, and unassignment
app.post('/webhooks/jira', handleJiraWebhook);

async function ensureTrelloWebhooks(): Promise<void> {
  const { apiKey, token, boards } = config.trello;
  const { webhookBaseUrl } = config.server;

  if (!apiKey || !token || !webhookBaseUrl) {
    logger.warn('Trello webhook auto-registration skipped — missing apiKey, token, or webhookBaseUrl');
    return;
  }

  let existing: Array<{ id: string; idModel: string; callbackURL: string }>;
  try {
    const res = await fetch(
      `https://api.trello.com/1/tokens/${token}/webhooks?key=${apiKey}&token=${token}`,
    );
    existing = await res.json() as typeof existing;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch existing Trello webhooks');
    return;
  }

  for (const board of boards) {
    const callbackURL = `${webhookBaseUrl}/webhooks/trello`;
    const match = existing.find((w) => w.idModel === board.id);

    if (match?.callbackURL === callbackURL) {
      logger.info({ boardId: board.id }, 'Trello webhook already registered');
      continue;
    }

    if (match) {
      // Webhook exists but points to a stale URL — update it in place
      try {
        const res = await fetch(`https://api.trello.com/1/webhooks/${match.id}?key=${apiKey}&token=${token}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callbackURL }),
        });
        if (!res.ok) {
          const body = await res.text();
          logger.warn({ boardId: board.id, status: res.status, body, oldUrl: match.callbackURL }, 'Failed to update stale Trello webhook');
        } else {
          logger.info({ boardId: board.id, oldUrl: match.callbackURL, newUrl: callbackURL }, 'Updated stale Trello webhook');
        }
      } catch (err) {
        logger.warn({ boardId: board.id, err }, 'Failed to update stale Trello webhook');
      }
      continue;
    }

    try {
      const res = await fetch(`https://api.trello.com/1/webhooks?key=${apiKey}&token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackURL, idModel: board.id, description: 'Claude SWE Agent' }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.warn({ boardId: board.id, status: res.status, body }, 'Failed to register Trello webhook');
      } else {
        logger.info({ boardId: board.id }, 'Registered Trello webhook');
      }
    } catch (err) {
      logger.warn({ boardId: board.id, err }, 'Failed to register Trello webhook');
    }
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'Unhandled promise rejection');
});

(async () => {
  await initBotMemberId();
  await initJiraBotAccountId();
  await resolveNames();

  const server = app.listen(config.server.port, () => {
    logger.info({ port: config.server.port }, 'Webhook server listening');
    logger.info('Worker started and waiting for jobs');
  });

  // Register webhooks AFTER server is listening — platforms verify the callback URL
  // by sending a request during registration, so the server must be ready first.
  await ensureTrelloWebhooks();
  await registerJiraWebhooks();
  await startSlack();

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutting down');
    server.close();
    await gracefulShutdown();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();

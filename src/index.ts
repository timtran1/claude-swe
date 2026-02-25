import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleTrelloWebhook, handleGitHubWebhook } from './webhook/handler.js';
import { listWorkerContainers } from './containers/manager.js';
import { worker, gracefulShutdown } from './queue/worker.js';

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
  });
});

// List active worker containers
app.get('/workers', async (_req, res) => {
  const containers = await listWorkerContainers();
  res.json(containers);
});

// Trello webhook — handle both HEAD (verification) and POST (events)
app.all('/webhooks/trello', handleTrelloWebhook);

// GitHub webhook — handles PR closed → container cleanup
app.post('/webhooks/github', handleGitHubWebhook);

async function ensureTrelloWebhooks(): Promise<void> {
  const { apiKey, token, boards } = config.trello;
  const { webhookBaseUrl } = config.server;

  if (!apiKey || !token || !webhookBaseUrl) {
    logger.warn('Trello webhook auto-registration skipped — missing apiKey, token, or webhookBaseUrl');
    return;
  }

  let existing: Array<{ idModel: string; callbackURL: string }>;
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
    const alreadyRegistered = existing.some(
      (w) => w.idModel === board.id && w.callbackURL === callbackURL,
    );

    if (alreadyRegistered) {
      logger.info({ boardId: board.id }, 'Trello webhook already registered');
      continue;
    }

    try {
      await fetch(`https://api.trello.com/1/webhooks?key=${apiKey}&token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackURL, idModel: board.id, description: 'Claude SWE Agent' }),
      });
      logger.info({ boardId: board.id }, 'Registered Trello webhook');
    } catch (err) {
      logger.warn({ boardId: board.id, err }, 'Failed to register Trello webhook');
    }
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

(async () => {
  await ensureTrelloWebhooks();

  const server = app.listen(config.server.port, () => {
    logger.info({ port: config.server.port }, 'Webhook server listening');
    logger.info('Worker started and waiting for jobs');
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutting down');
    server.close();
    await gracefulShutdown();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();

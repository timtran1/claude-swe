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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
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

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'Webhook server listening');
  logger.info('Worker started and waiting for jobs');
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  server.close();
  await gracefulShutdown();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

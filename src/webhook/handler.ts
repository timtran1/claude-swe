import crypto from 'crypto';
import type { Request, Response } from 'express';
import { config, getBoardConfig } from '../config.js';
import { logger } from '../logger.js';
import { taskQueue } from '../queue/queue.js';
import type {
  TrelloWebhookPayload,
  GitHubPRWebhookPayload,
  NewTaskJob,
  FeedbackJob,
  CleanupJob,
} from './types.js';

// --- Trello webhook ---
// Trello signs requests with HMAC-SHA1 using the OAuth token as the key.

function verifyTrelloSignature(rawBody: Buffer, signature: string): boolean {
  const token = config.trello.token;
  if (!token) {
    logger.warn('Trello token not configured — skipping signature verification');
    return true;
  }
  const content = rawBody.toString('utf8') + config.server.webhookBaseUrl + '/webhooks/trello';
  const expected = crypto
    .createHmac('sha1', token)
    .update(content)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function handleTrelloWebhook(req: Request, res: Response): void {
  if (req.method === 'HEAD') {
    res.sendStatus(200);
    return;
  }

  const signature = req.headers['x-trello-webhook'] as string | undefined;
  const rawBody: Buffer = (req as Request & { rawBody: Buffer }).rawBody;

  if (!signature) {
    logger.warn('Webhook received without x-trello-webhook header');
    res.sendStatus(401);
    return;
  }

  if (!verifyTrelloSignature(rawBody, signature)) {
    logger.warn('Webhook signature verification failed');
    res.sendStatus(401);
    return;
  }

  const payload = req.body as TrelloWebhookPayload;
  const action = payload?.action;

  if (!action) {
    res.sendStatus(200);
    return;
  }

  routeTrelloAction(action).catch((err) => {
    logger.error({ err }, 'Failed to enqueue Trello webhook action');
  });

  res.sendStatus(200);
}

async function routeTrelloAction(action: TrelloWebhookPayload['action']): Promise<void> {
  const { type, data, memberCreator } = action;

  if (type === 'addMemberToCard') {
    const card = data.card;
    const member = data.member;
    const board = data.board;

    if (!card || !board) return;

    const boardConfig = getBoardConfig(board.id);
    if (!boardConfig) return;

    if (member?.username !== config.trello.botUsername) return;

    // If includeLists is configured, only react to cards in those lists
    if (boardConfig.includeLists.length > 0 && !boardConfig.includeLists.includes(card.idList)) {
      logger.info({ cardId: card.id, listId: card.idList }, 'Card not in an included list — ignoring');
      return;
    }

    const job: NewTaskJob = {
      cardId: card.id,
      cardShortLink: card.shortLink,
      cardName: card.name,
      cardDesc: card.desc,
      cardUrl: card.url,
      doneListId: boardConfig.done?.listId,
    };

    await taskQueue.add('new-task', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    });

    logger.info({ cardId: card.id, cardName: card.name }, 'Enqueued new-task');
    return;
  }

  if (type === 'commentCard') {
    const card = data.card;
    const commentText = data.text;
    const board = data.board;

    if (!card || !commentText || !board) return;

    const boardConfig = getBoardConfig(board.id);
    if (!boardConfig) return;

    if (memberCreator.username === config.trello.botUsername) return;

    // If includeLists is configured, only react to cards in those lists
    if (boardConfig.includeLists.length > 0 && !boardConfig.includeLists.includes(card.idList)) {
      return;
    }

    const job: FeedbackJob = {
      cardId: card.id,
      cardShortLink: card.shortLink,
      cardUrl: card.url,
      cardDesc: card.desc,
      commentText,
      commenterName: memberCreator.fullName,
      doneListId: boardConfig.done?.listId,
    };

    await taskQueue.add('feedback', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    });

    logger.info({ cardId: card.id, commenter: memberCreator.username }, 'Enqueued feedback');
    return;
  }
}

// --- GitHub webhook ---

function verifyGitHubSignature(rawBody: Buffer, signature: string): boolean {
  const secret = config.github.webhookSecret;
  if (!secret) {
    logger.warn('GitHub webhook secret not configured — skipping signature verification');
    return true;
  }
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function handleGitHubWebhook(req: Request, res: Response): void {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody: Buffer = (req as Request & { rawBody: Buffer }).rawBody;
  const event = req.headers['x-github-event'] as string | undefined;

  if (!signature) {
    logger.warn('GitHub webhook received without signature header');
    res.sendStatus(401);
    return;
  }

  if (!verifyGitHubSignature(rawBody, signature)) {
    logger.warn('GitHub webhook signature verification failed');
    res.sendStatus(401);
    return;
  }

  if (event === 'pull_request') {
    routeGitHubPR(req.body as GitHubPRWebhookPayload).catch((err) => {
      logger.error({ err }, 'Failed to process GitHub PR webhook');
    });
  }

  res.sendStatus(200);
}

async function routeGitHubPR(payload: GitHubPRWebhookPayload): Promise<void> {
  const { action, pull_request } = payload;

  // Only clean up when PR is closed (merged or not)
  if (action !== 'closed') return;

  const branch = pull_request.head.ref;

  // Only handle branches we created: claude/<cardShortLink>
  if (!branch.startsWith('claude/')) return;

  const cardShortLink = branch.replace('claude/', '');

  const job: CleanupJob = {
    cardShortLink,
    prUrl: pull_request.html_url,
    reason: pull_request.merged ? 'merged' : 'closed',
  };

  await taskQueue.add('cleanup', job);

  logger.info(
    { cardShortLink, pr: pull_request.html_url, reason: job.reason },
    'Enqueued cleanup for closed PR',
  );
}

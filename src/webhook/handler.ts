import crypto from 'crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { taskQueue } from '../queue/queue.js';
import type { TrelloWebhookPayload, NewTaskJob, FeedbackJob } from './types.js';

// Trello signs webhooks with HMAC-SHA1 of (body + callbackURL), base64 encoded
function verifySignature(rawBody: Buffer, signature: string): boolean {
  const content = rawBody.toString('utf8') + config.WEBHOOK_BASE_URL + '/webhooks/trello';
  const expected = crypto
    .createHmac('sha1', config.TRELLO_WEBHOOK_SECRET)
    .update(content)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function handleTrelloWebhook(req: Request, res: Response): void {
  // HEAD request is Trello's way of verifying the webhook URL exists
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

  if (!verifySignature(rawBody, signature)) {
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

  routeAction(action).catch((err) => {
    logger.error({ err }, 'Failed to enqueue webhook action');
  });

  // Respond immediately — Trello expects fast responses
  res.sendStatus(200);
}

async function routeAction(action: TrelloWebhookPayload['action']): Promise<void> {
  const { type, data, memberCreator } = action;

  if (type === 'addMemberToCard') {
    const card = data.card;
    const member = data.member;

    if (!card) return;

    // Only react when claude is the member being added
    // Trello username for your Claude bot should be set in env or hardcoded
    const claudeUsername = process.env.TRELLO_CLAUDE_USERNAME ?? 'claude';
    if (member?.username !== claudeUsername) return;

    const job: NewTaskJob = {
      cardId: card.id,
      cardShortLink: card.shortLink,
      cardName: card.name,
      cardDesc: card.desc,
      cardUrl: card.url,
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

    if (!card || !commentText) return;

    // Ignore comments from the bot itself to avoid loops
    const botUsername = process.env.TRELLO_CLAUDE_USERNAME ?? 'claude';
    if (memberCreator.username === botUsername) return;

    const job: FeedbackJob = {
      cardId: card.id,
      cardShortLink: card.shortLink,
      cardUrl: card.url,
      commentText,
      commenterName: memberCreator.fullName,
    };

    await taskQueue.add('feedback', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    });

    logger.info({ cardId: card.id, commenter: memberCreator.username }, 'Enqueued feedback');
    return;
  }
}

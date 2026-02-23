import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// Mock config before importing handler
vi.mock('../src/config.js', () => ({
  config: {
    TRELLO_API_KEY: 'test-key',
    TRELLO_TOKEN: 'test-token',
    TRELLO_WEBHOOK_SECRET: 'test-secret',
    TRELLO_DONE_LIST_ID: 'list-done',
    TRELLO_BOARD_ID: 'board-1',
    GITHUB_TOKEN: 'gh-token',
    ANTHROPIC_API_KEY: 'anth-key',
    WEBHOOK_BASE_URL: 'https://example.com',
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    CLAUDE_TIMEOUT_MS: 1800000,
    PORT: 3000,
  },
}));

vi.mock('../src/queue/queue.js', () => ({
  taskQueue: { add: vi.fn().mockResolvedValue({ id: 'job-1' }) },
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { taskQueue } from '../src/queue/queue.js';
import type { Request, Response } from 'express';

function makeSignature(body: string, secret: string, callbackUrl: string): string {
  const content = body + callbackUrl + '/webhooks/trello';
  return crypto.createHmac('sha1', secret).update(content).digest('base64');
}

function mockReq(body: unknown, signature: string): Request {
  const bodyStr = JSON.stringify(body);
  const rawBody = Buffer.from(bodyStr);
  return {
    method: 'POST',
    headers: { 'x-trello-webhook': signature },
    body,
    rawBody,
  } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; sent: boolean } {
  const res = {
    statusCode: 200,
    sent: false,
    sendStatus(code: number) {
      this.statusCode = code;
      this.sent = true;
      return this;
    },
    json(data: unknown) {
      this.sent = true;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; sent: boolean };
}

describe('handleTrelloWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('responds 200 to HEAD verification requests', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');
    const req = { method: 'HEAD', headers: {}, body: {} } as unknown as Request;
    const res = mockRes();
    handleTrelloWebhook(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects requests with no signature', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');
    const req = {
      method: 'POST',
      headers: {},
      body: {},
      rawBody: Buffer.from('{}'),
    } as unknown as Request;
    const res = mockRes();
    handleTrelloWebhook(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with invalid signature', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');
    const req = mockReq({ action: { type: 'addMemberToCard' } }, 'bad-sig');
    const res = mockRes();
    handleTrelloWebhook(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('enqueues new-task job when @claude is added to a card', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');

    const payload = {
      action: {
        type: 'addMemberToCard',
        memberCreator: { id: 'u1', username: 'tim', fullName: 'Tim' },
        data: {
          card: { id: 'card-1', shortLink: 'abc123', name: 'Fix login bug', desc: '', url: 'https://trello.com/c/abc123' },
          member: { id: 'u2', username: 'claude', fullName: 'Claude' },
          board: { id: 'board-1', name: 'My Board' },
        },
        id: 'act-1',
        date: new Date().toISOString(),
      },
      model: { id: 'board-1', name: 'My Board' },
    };

    const bodyStr = JSON.stringify(payload);
    const sig = makeSignature(bodyStr, 'test-secret', 'https://example.com');
    const req = {
      method: 'POST',
      headers: { 'x-trello-webhook': sig },
      body: payload,
      rawBody: Buffer.from(bodyStr),
    } as unknown as Request;
    const res = mockRes();

    handleTrelloWebhook(req, res);

    // Let async routeAction run
    await new Promise((r) => setTimeout(r, 10));

    expect(res.statusCode).toBe(200);
    expect(taskQueue.add).toHaveBeenCalledWith(
      'new-task',
      expect.objectContaining({ cardId: 'card-1', cardName: 'Fix login bug' }),
      expect.any(Object),
    );
  });

  it('enqueues feedback job when a human comments on a card', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');

    const payload = {
      action: {
        type: 'commentCard',
        memberCreator: { id: 'u1', username: 'tim', fullName: 'Tim' },
        data: {
          card: { id: 'card-2', shortLink: 'xyz789', name: 'Build dashboard', desc: '', url: 'https://trello.com/c/xyz789' },
          text: 'Please also add a loading spinner',
          board: { id: 'board-1', name: 'My Board' },
        },
        id: 'act-2',
        date: new Date().toISOString(),
      },
      model: { id: 'board-1', name: 'My Board' },
    };

    const bodyStr = JSON.stringify(payload);
    const sig = makeSignature(bodyStr, 'test-secret', 'https://example.com');
    const req = {
      method: 'POST',
      headers: { 'x-trello-webhook': sig },
      body: payload,
      rawBody: Buffer.from(bodyStr),
    } as unknown as Request;
    const res = mockRes();

    handleTrelloWebhook(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(res.statusCode).toBe(200);
    expect(taskQueue.add).toHaveBeenCalledWith(
      'feedback',
      expect.objectContaining({
        cardId: 'card-2',
        commentText: 'Please also add a loading spinner',
      }),
      expect.any(Object),
    );
  });
});

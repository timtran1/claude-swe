import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { config } from '../config.js';

// TTL for log session tokens — long enough to review logs after a task finishes
const TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24 hours

const redis = new Redis({ host: config.redis.host, port: config.redis.port });

function tokenKey(token: string): string {
  return `logs:token:${token}`;
}

function cardKey(cardShortLink: string): string {
  return `logs:card:${cardShortLink}`;
}

export interface LogSessionMeta {
  token: string;
  cardShortLink: string;
  cardId: string;
  cardName: string;
}

export async function createLogSession(
  cardShortLink: string,
  cardId: string,
  cardName: string,
): Promise<LogSessionMeta> {
  const token = randomUUID();
  const meta: LogSessionMeta = { token, cardShortLink, cardId, cardName };
  const value = JSON.stringify(meta);

  await Promise.all([
    redis.setex(tokenKey(token), TOKEN_TTL_SECONDS, value),
    redis.setex(cardKey(cardShortLink), TOKEN_TTL_SECONDS, token),
  ]);

  return meta;
}

export async function getLogSession(token: string): Promise<LogSessionMeta | null> {
  const value = await redis.get(tokenKey(token));
  if (!value) return null;
  return JSON.parse(value) as LogSessionMeta;
}

export async function removeLogSession(token: string): Promise<void> {
  const value = await redis.get(tokenKey(token));
  if (value) {
    const meta = JSON.parse(value) as LogSessionMeta;
    await Promise.all([
      redis.del(tokenKey(token)),
      redis.del(cardKey(meta.cardShortLink)),
    ]);
  }
}

export async function removeLogSessionByCard(cardShortLink: string): Promise<void> {
  const token = await redis.get(cardKey(cardShortLink));
  if (token) await removeLogSession(token);
}

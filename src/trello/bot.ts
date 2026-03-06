import { config } from '../config.js';
import { logger } from '../logger.js';

export let botMemberId: string | null = null;

export async function initBotMemberId(): Promise<void> {
  if (botMemberId) return;
  const { apiKey, token, botUsername } = config.trello;
  if (!apiKey || !token || !botUsername) return;
  try {
    const res = await fetch(
      `https://api.trello.com/1/members/${botUsername}?fields=id&key=${apiKey}&token=${token}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { id: string };
    botMemberId = data.id;
    logger.info({ botMemberId }, 'Resolved bot Trello member ID');
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve bot member ID — member check will be skipped');
  }
}

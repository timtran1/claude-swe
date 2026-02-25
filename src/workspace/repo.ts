import { config } from '../config.js';

/**
 * Extract GitHub repo URL from a Trello card description.
 * Convention: include `repo: https://github.com/org/name` in the card.
 * Falls back to config.github.defaultRepo.
 */
export function extractRepoUrl(cardDesc: string): string | null {
  const match = cardDesc.match(/repo:\s*(https?:\/\/github\.com\/[^\s]+)/i);
  if (match) return match[1].trim();
  return config.github.defaultRepo || null;
}

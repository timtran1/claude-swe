import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Map shorthand model names to full Anthropic model IDs.
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

function resolveModelId(name: string): string {
  return MODEL_ALIASES[name] ?? name;
}

/**
 * Uses a cheap Haiku call to determine whether a Trello comment is actually
 * feedback or an instruction directed at the AI agent, vs. a human-to-human
 * conversation that should be ignored.
 *
 * Defaults to true (process the feedback) on any error to avoid accidentally
 * suppressing legitimate feedback.
 */
export async function shouldProcessFeedback(
  commentText: string,
  commenterName: string,
  cardName: string,
): Promise<boolean> {
  const apiKey = config.anthropic.apiKey;
  if (!apiKey) {
    logger.warn({ phase: 'guard' }, 'Anthropic API key not configured — skipping guard, processing feedback');
    return true;
  }

  const modelId = resolveModelId(config.agent.models.guard);
  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 10,
      system: `You are a classifier. A human commented on a Trello card that has an AI coding agent assigned to it.
Determine whether the comment is feedback, a request, or an instruction directed at the AI agent — or whether it is a human-to-human conversation the agent should ignore (e.g. status updates, questions between teammates, general chatter unrelated to code changes).
Reply with exactly YES if the agent should act on this comment, or NO if it should be ignored. No other output.`,
      messages: [
        {
          role: 'user',
          content: `Card: "${cardName}"
Commenter: ${commenterName}
Comment: "${commentText}"`,
        },
      ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim().toUpperCase() : '';
    const result = text.startsWith('YES');
    logger.info({ phase: 'guard', model: modelId, result, commenterName }, 'Guard classification complete');
    return result;
  } catch (err) {
    logger.warn({ err, phase: 'guard' }, 'Guard API call failed — defaulting to process feedback');
    return true;
  }
}

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

export type GuardResult =
  | { type: 'ignore' }
  | { type: 'feedback' }
  | { type: 'operation'; action: string; target?: string };

/**
 * Uses a cheap Haiku call to classify a Trello comment into one of three categories:
 * - 'ignore': human-to-human conversation the agent should not act on
 * - 'feedback': feedback or instruction directed at the agent → spin up container
 * - 'operation': an operational command (stop, move, restart, archive) → execute inline
 *
 * Defaults to { type: 'feedback' } (process the comment) on any error to avoid
 * accidentally suppressing legitimate feedback.
 */
export async function classifyComment(
  commentText: string,
  commenterName: string,
  cardName: string,
  boardLists: { id: string; name: string }[],
): Promise<GuardResult> {
  const apiKey = config.anthropic.apiKey;
  if (!apiKey) {
    logger.warn({ phase: 'guard' }, 'Anthropic API key not configured — skipping guard, processing feedback');
    return { type: 'feedback' };
  }

  const modelId = resolveModelId(config.agent.models.guard);
  const client = new Anthropic({ apiKey });

  const listNames = boardLists.length > 0
    ? boardLists.map((l) => `  - ${l.name}`).join('\n')
    : '  (none available)';

  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 50,
      system: `You are a classifier for comments on a task with an AI coding agent assigned.

Classify the comment into exactly one category and reply with a single line:

IGNORE — Human-to-human conversation the agent should not act on (status updates, chatter, questions between teammates unrelated to the agent's work).
FEEDBACK — A request, instruction, or feedback directed at the AI coding agent about code or implementation. Spin up a worker container to handle it.
OP:stop — The user wants to stop, cancel, or kill the running worker.
OP:move:<status/list name> — The user wants to move this task to a different status or list. Use the exact status/list name from the available options below.
OP:restart — The user wants to start over, reset, or redo the task from scratch.
OP:archive — The user wants to archive or close this task.

Available statuses/lists:
${listNames}

Reply with exactly one of the above options. No other output.`,
      messages: [
        {
          role: 'user',
          content: `Card: "${cardName}"
Commenter: ${commenterName}
Comment: "${commentText}"`,
        },
      ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    const upper = text.toUpperCase();

    if (upper === 'IGNORE' || upper === 'NO') {
      logger.info({ phase: 'guard', model: modelId, result: 'ignore', commenterName }, 'Guard classification complete');
      return { type: 'ignore' };
    }

    if (upper.startsWith('OP:')) {
      const parts = text.substring(3).split(':');
      const action = parts[0].toLowerCase().trim();
      const target = parts.slice(1).join(':').trim() || undefined;
      logger.info({ phase: 'guard', model: modelId, result: 'operation', action, target, commenterName }, 'Guard classification complete');
      return { type: 'operation', action, target };
    }

    // 'FEEDBACK', 'YES', or anything else → process as feedback (fail-open)
    logger.info({ phase: 'guard', model: modelId, result: 'feedback', commenterName }, 'Guard classification complete');
    return { type: 'feedback' };
  } catch (err) {
    logger.warn({ err, phase: 'guard' }, 'Guard API call failed — defaulting to process feedback');
    return { type: 'feedback' };
  }
}

import { logger } from './logger.js';
import { postTrelloComment } from './trello/api.js';
import { postSlackReply } from './slack/client.js';
import { addJiraComment } from './jira/api.js';
import type { TaskSource } from './webhook/types.js';

/**
 * Post a status message to the correct platform(s) based on the task source.
 * For Slack tasks that also have a linked Trello card, posts to both.
 * Swallows errors with logging — never throws.
 */
export async function postStatus(source: TaskSource, message: string): Promise<void> {
  if (source.type === 'trello') {
    await postTrelloComment(source.cardId, message).catch((err) =>
      logger.warn({ err, cardId: source.cardId }, 'Failed to post Trello comment'),
    );
    return;
  }

  if (source.type === 'slack') {
    await postSlackReply(source.channelId, source.threadTs, message).catch((err) =>
      logger.warn({ err, channelId: source.channelId, threadTs: source.threadTs }, 'Failed to post Slack reply'),
    );

    // If a Trello card is linked, also post there
    if (source.trelloCardId) {
      await postTrelloComment(source.trelloCardId, message).catch((err) =>
        logger.warn({ err, cardId: source.trelloCardId }, 'Failed to post cross-linked Trello comment'),
      );
    }
  }

  if (source.type === 'jira') {
    await addJiraComment(source.issueKey, message).catch((err) =>
      logger.warn({ err, issueKey: source.issueKey }, 'Failed to post Jira comment'),
    );
  }
}

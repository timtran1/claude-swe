import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '../logger.js';
import { destroyTaskContainer } from '../containers/manager.js';
import { postTrelloComment, moveCardToList, archiveCard } from '../trello/api.js';
import type { GuardResult } from './guard.js';
import type { FeedbackJob, NewTaskJob } from '../webhook/types.js';

interface OperationContext {
  cancelledCards: Set<string>;
  activeNewTaskJobs: Map<string, AbortController>;
  activeFeedbackJobs: Map<string, AbortController>;
  taskQueue: Queue;
}

/**
 * Execute an operational command detected by the guard classifier.
 * These are administrative actions (stop, move, restart, archive) that the
 * orchestrator handles directly without spinning up a worker container.
 */
export async function executeOperation(
  result: GuardResult & { type: 'operation' },
  jobData: FeedbackJob,
  boardLists: { id: string; name: string }[],
  context: OperationContext,
): Promise<void> {
  const { cardId, cardShortLink, cardName, cardUrl, cardDesc, boardId, doingListId, doneListId } = jobData;
  const { cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue } = context;
  const log = logger.child({ phase: 'operation', action: result.action, cardShortLink });

  log.info({ target: result.target }, 'Executing operational command');

  switch (result.action) {
    case 'stop':
      await executeStop({ cardId, cardShortLink, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      break;

    case 'move':
      await executeMove({ cardId, cardShortLink, target: result.target, boardLists, log });
      break;

    case 'restart':
      await executeRestart({ cardId, cardShortLink, cardName, cardUrl, cardDesc, boardId, doingListId, doneListId, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      break;

    case 'archive':
      await executeArchive({ cardId, cardShortLink, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      break;

    default:
      log.warn({ action: result.action }, 'Unknown operational command — ignoring');
  }
}

// --- Individual operation handlers ---

async function executeStop(opts: {
  cardId: string;
  cardShortLink: string;
  cancelledCards: Set<string>;
  activeNewTaskJobs: Map<string, AbortController>;
  activeFeedbackJobs: Map<string, AbortController>;
  taskQueue: Queue;
  log: Logger;
}): Promise<void> {
  const { cardId, cardShortLink, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log } = opts;

  cancelledCards.add(cardShortLink);

  // Abort in-flight jobs
  activeNewTaskJobs.get(cardShortLink)?.abort();
  activeFeedbackJobs.get(cardShortLink)?.abort();

  // Drain queued jobs
  try {
    const pending = await taskQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    for (const j of pending) {
      const d = j.data as { cardShortLink?: string };
      if (d.cardShortLink === cardShortLink && (j.name === 'new-task' || j.name === 'feedback')) {
        await j.remove();
        log.info({ jobId: j.id, jobName: j.name }, 'Removed queued job');
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to drain queued jobs — continuing');
  }

  await destroyTaskContainer(cardShortLink);
  log.info('Container destroyed');

  await postTrelloComment(cardId, '🛑 Stopped. Worker has been killed and cleaned up.').catch((err) =>
    log.warn({ err }, 'Failed to post stop confirmation comment'),
  );
}

async function executeMove(opts: {
  cardId: string;
  cardShortLink: string;
  target: string | undefined;
  boardLists: { id: string; name: string }[];
  log: Logger;
}): Promise<void> {
  const { cardId, cardShortLink, target, boardLists, log } = opts;

  if (!target) {
    await postTrelloComment(cardId, '⚠️ No list name specified. Available lists:\n' + boardLists.map((l) => `- ${l.name}`).join('\n')).catch(() => {});
    return;
  }

  const targetLower = target.toLowerCase();
  const match = boardLists.find((l) => l.name.toLowerCase() === targetLower);

  if (!match) {
    const available = boardLists.map((l) => `- ${l.name}`).join('\n');
    await postTrelloComment(cardId, `⚠️ List "${target}" not found. Available lists:\n${available}`).catch(() => {});
    log.warn({ target }, 'Move target list not found');
    return;
  }

  await moveCardToList(cardId, match.id);
  log.info({ target, listId: match.id }, 'Card moved');

  await postTrelloComment(cardId, `✅ Moved to **${match.name}**.`).catch((err) =>
    log.warn({ err }, 'Failed to post move confirmation comment'),
  );
}

async function executeRestart(opts: {
  cardId: string;
  cardShortLink: string;
  cardName: string;
  cardUrl: string;
  cardDesc: string;
  boardId: string;
  doingListId?: string;
  doneListId?: string;
  cancelledCards: Set<string>;
  activeNewTaskJobs: Map<string, AbortController>;
  activeFeedbackJobs: Map<string, AbortController>;
  taskQueue: Queue;
  log: Logger;
}): Promise<void> {
  const { cardId, cardShortLink, cardName, cardUrl, cardDesc, boardId, doingListId, doneListId, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log } = opts;

  // Stop everything first (same as stop operation)
  cancelledCards.add(cardShortLink);
  activeNewTaskJobs.get(cardShortLink)?.abort();
  activeFeedbackJobs.get(cardShortLink)?.abort();

  try {
    const pending = await taskQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    for (const j of pending) {
      const d = j.data as { cardShortLink?: string };
      if (d.cardShortLink === cardShortLink && (j.name === 'new-task' || j.name === 'feedback')) {
        await j.remove();
        log.info({ jobId: j.id, jobName: j.name }, 'Removed queued job for restart');
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to drain queued jobs — continuing with restart');
  }

  await destroyTaskContainer(cardShortLink);
  log.info('Container destroyed for restart');

  // Clear cancelled state so the re-enqueued new-task runs cleanly
  cancelledCards.delete(cardShortLink);

  // Re-enqueue as a fresh new-task
  const newTaskJob: NewTaskJob = { cardId, cardShortLink, cardName, cardUrl, cardDesc, boardId, doingListId, doneListId };
  await taskQueue.add('new-task', newTaskJob, { attempts: 1 });
  log.info('Re-enqueued new-task job for restart');

  await postTrelloComment(cardId, '🔄 Restarting from scratch. A fresh worker will spin up shortly.').catch((err) =>
    log.warn({ err }, 'Failed to post restart confirmation comment'),
  );
}

async function executeArchive(opts: {
  cardId: string;
  cardShortLink: string;
  cancelledCards: Set<string>;
  activeNewTaskJobs: Map<string, AbortController>;
  activeFeedbackJobs: Map<string, AbortController>;
  taskQueue: Queue;
  log: Logger;
}): Promise<void> {
  const { cardId, cardShortLink, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log } = opts;

  // Post confirmation before archiving (card won't be visible after)
  await postTrelloComment(cardId, '📦 Archiving this card. Worker will be cleaned up.').catch((err) =>
    log.warn({ err }, 'Failed to post archive confirmation comment'),
  );

  // Mark as cancelled to suppress spurious failure comments from any running work
  cancelledCards.add(cardShortLink);
  activeNewTaskJobs.get(cardShortLink)?.abort();
  activeFeedbackJobs.get(cardShortLink)?.abort();

  // Drain queued jobs
  try {
    const pending = await taskQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    for (const j of pending) {
      const d = j.data as { cardShortLink?: string };
      if (d.cardShortLink === cardShortLink && (j.name === 'new-task' || j.name === 'feedback')) {
        await j.remove();
        log.info({ jobId: j.id, jobName: j.name }, 'Removed queued job for archived card');
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to drain queued jobs — continuing with archive');
  }

  // Archive the card — this fires the updateCard webhook which enqueues a cleanup job
  await archiveCard(cardId);
  log.info('Card archived');
}

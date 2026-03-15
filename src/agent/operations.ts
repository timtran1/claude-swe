import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '../logger.js';
import { destroyTaskContainer } from '../containers/manager.js';
import { postTrelloComment, moveCardToList, archiveCard } from '../trello/api.js';
import { getJiraTransitions, transitionJiraIssue } from '../jira/api.js';
import { postStatus } from '../notify.js';
import { getTaskSource } from '../webhook/types.js';
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
  const { cardShortLink, cardDesc, doingListId, doneListId } = jobData;
  const cardId = jobData.cardId;
  const boardId = jobData.boardId;
  const cardName = jobData.cardName;
  const cardUrl = jobData.cardUrl;
  const { cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue } = context;
  const log = logger.child({ phase: 'operation', action: result.action, cardShortLink });
  const source = getTaskSource(jobData);

  log.info({ target: result.target }, 'Executing operational command');

  switch (result.action) {
    case 'stop':
      await executeStop({ cardShortLink, source, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      break;

    case 'move':
      if (source.type === 'jira') {
        await executeJiraMove({ issueKey: source.issueKey, target: result.target, source, log });
      } else if (source.type !== 'trello' || !cardId) {
        await postStatus(source, '⚠️ The `move` command is only available for Trello and Jira tasks.').catch(() => {});
      } else {
        await executeMove({ cardId, cardShortLink, target: result.target, boardLists, log });
      }
      break;

    case 'restart':
      await executeRestart({ cardId, cardShortLink, cardName, cardUrl, cardDesc: cardDesc ?? '', boardId, doingListId, doneListId, repos: jobData.repos, source, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      break;

    case 'archive':
      if (source.type === 'jira') {
        // Transition to a done/closed status, then stop and clean up
        const jiraTransitions = await getJiraTransitions(source.issueKey).catch(() => [] as { id: string; name: string }[]);
        const doneTransition = jiraTransitions.find((t) => /^(done|closed|resolved)$/i.test(t.name));
        if (doneTransition) {
          await transitionJiraIssue(source.issueKey, doneTransition.id).catch((err) =>
            log.warn({ err }, 'Failed to transition Jira issue to Done for archive — continuing with stop'),
          );
        }
        await executeStop({ cardShortLink, source, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      } else if (source.type !== 'trello' || !cardId) {
        // For Slack tasks, "archive" means stop + cleanup (no Trello card to archive)
        await executeStop({ cardShortLink, source, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      } else {
        await executeArchive({ cardId, cardShortLink, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log });
      }
      break;

    default:
      log.warn({ action: result.action }, 'Unknown operational command — ignoring');
  }
}

// --- Individual operation handlers ---

async function executeStop(opts: {
  cardShortLink: string;
  source: ReturnType<typeof getTaskSource>;
  cancelledCards: Set<string>;
  activeNewTaskJobs: Map<string, AbortController>;
  activeFeedbackJobs: Map<string, AbortController>;
  taskQueue: Queue;
  log: Logger;
}): Promise<void> {
  const { cardShortLink, source, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log } = opts;

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

  await postStatus(source, '🛑 Stopped. Worker has been killed and cleaned up.').catch((err) =>
    log.warn({ err }, 'Failed to post stop confirmation'),
  );
}

async function executeMove(opts: {
  cardId: string;
  cardShortLink: string;
  target: string | undefined;
  boardLists: { id: string; name: string }[];
  log: Logger;
}): Promise<void> {
  const { cardId, target, boardLists, log } = opts;

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

async function executeJiraMove(opts: {
  issueKey: string;
  target: string | undefined;
  source: ReturnType<typeof getTaskSource>;
  log: Logger;
}): Promise<void> {
  const { issueKey, target, source, log } = opts;
  const transitions = await getJiraTransitions(issueKey).catch(() => [] as { id: string; name: string }[]);

  if (!target) {
    await postStatus(source, '⚠️ No status specified. Available transitions:\n' + transitions.map((t) => `- ${t.name}`).join('\n')).catch(() => {});
    return;
  }

  const match = transitions.find((t) => t.name.toLowerCase() === target.toLowerCase());
  if (!match) {
    const available = transitions.map((t) => `- ${t.name}`).join('\n');
    await postStatus(source, `⚠️ Transition "${target}" not available. Available transitions:\n${available}`).catch(() => {});
    log.warn({ target }, 'Jira move target transition not found');
    return;
  }

  await transitionJiraIssue(issueKey, match.id);
  log.info({ target, transitionId: match.id }, 'Jira issue transitioned');

  await postStatus(source, `✅ Transitioned to **${match.name}**.`).catch((err) =>
    log.warn({ err }, 'Failed to post Jira move confirmation'),
  );
}

async function executeRestart(opts: {
  cardId?: string;
  cardShortLink: string;
  cardName: string;
  cardUrl: string;
  cardDesc: string;
  boardId?: string;
  doingListId?: string;
  doneListId?: string;
  repos?: string[];
  source: ReturnType<typeof getTaskSource>;
  cancelledCards: Set<string>;
  activeNewTaskJobs: Map<string, AbortController>;
  activeFeedbackJobs: Map<string, AbortController>;
  taskQueue: Queue;
  log: Logger;
}): Promise<void> {
  const { cardId, cardShortLink, cardName, cardUrl, cardDesc, boardId, doingListId, doneListId, repos, source, cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue, log } = opts;

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

  // Re-enqueue as a fresh new-task (repos carried for Jira/Slack tasks)
  const newTaskJob: NewTaskJob = { cardId, cardShortLink, cardName, cardUrl, cardDesc, boardId, doingListId, doneListId, repos, source };
  await taskQueue.add('new-task', newTaskJob, { attempts: 1 });
  log.info('Re-enqueued new-task job for restart');

  await postStatus(source, '🔄 Restarting from scratch. A fresh worker will spin up shortly.').catch((err) =>
    log.warn({ err }, 'Failed to post restart confirmation'),
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

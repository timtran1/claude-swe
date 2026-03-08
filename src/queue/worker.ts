import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { taskQueue } from './queue.js';
import { logger } from '../logger.js';
import { runTaskInContainer, destroyTaskContainer } from '../containers/manager.js';
import { buildPlanPrompt, buildExecutePrompt, buildNewTaskPrompt, buildFeedbackPrompt } from '../agent/prompt.js';
import { classifyComment } from '../agent/guard.js';
import { executeOperation } from '../agent/operations.js';
import { getBoardRepos, getAllRepoSlugs } from '../workspace/repo.js';
import { findOpenPRsForBranch } from '../github/pr.js';
import { postTrelloComment, moveCardToList, fetchBoardLists } from '../trello/api.js';
import { createLogSession, removeLogSessionByCard } from '../logs/store.js';
import type { NewTaskJob, FeedbackJob, CleanupJob, CancelJob } from '../webhook/types.js';

const connection = {
  host: config.redis.host,
  port: config.redis.port,
};

// Cards that have been explicitly cancelled (bot removed mid-flight).
// Used to suppress spurious failure comments when a container is killed by cancellation.
const cancelledCards = new Set<string>();

// Active feedback jobs keyed by cardShortLink.
// When a new feedback comment passes the guard, the old job is aborted so we always
// work on the latest comment rather than waiting for the previous one to finish.
const activeFeedbackJobs = new Map<string, AbortController>();

// Active new-task jobs keyed by cardShortLink.
// When a feedback comment passes the guard, the running new-task is killed immediately.
const activeNewTaskJobs = new Map<string, AbortController>();

export const worker = new Worker(
  'tasks',
  async (job: Job) => {
    switch (job.name) {
      case 'new-task':
        await handleNewTask(job as Job<NewTaskJob>);
        break;
      case 'feedback':
        await handleFeedback(job as Job<FeedbackJob>);
        break;
      case 'cleanup':
        await handleCleanup(job as Job<CleanupJob>);
        break;
      case 'cancel':
        await handleCancel(job as Job<CancelJob>);
        break;
      default:
        logger.warn({ jobName: job.name }, 'Unknown job type — skipping');
    }
  },
  { connection, concurrency: config.containers.concurrency },
);

async function handleNewTask(job: Job<NewTaskJob>): Promise<void> {
  const { cardId, cardShortLink, cardName, cardUrl, boardId } = job.data;
  const log = logger.child({ phase: 'queue', jobId: job.id, cardId, cardShortLink, cardName });

  log.info({ attempt: job.attemptsMade + 1, maxAttempts: job.opts?.attempts ?? 1 }, 'Picked up new-task job');
  cancelledCards.delete(cardShortLink); // Clear stale cancelled state in case bot was re-assigned

  const branchName = `claude/${cardShortLink}`;
  const repos = getBoardRepos(boardId);
  log.info({ branchName, repos }, 'Resolved branch and repos for task');

  const promptOpts = { cardId, cardShortLink, cardName, cardUrl, repos, imageDir: '/workspace/.card-images', doneListId: job.data.doneListId };
  const { planMode, models, prompts } = config.agent;
  const planModel = models.plan;
  const executeModel = models.execute;

  let containerOpts: Parameters<typeof runTaskInContainer>[0];

  if (planMode) {
    const planPrompt = buildPlanPrompt(promptOpts, prompts.plan);
    const executePrompt = buildExecutePrompt(promptOpts, prompts.execute);
    log.info({ planPromptLength: planPrompt.length, executePromptLength: executePrompt.length }, 'Built two-phase prompts');
    containerOpts = { cardShortLink, cardId, branchName, planPrompt, executePrompt, planModel, executeModel, isFollowUp: false, doneListId: job.data.doneListId };
  } else {
    const prompt = buildNewTaskPrompt(promptOpts, prompts.newTask);
    log.info({ promptLength: prompt.length }, 'Built single-phase prompt (planMode disabled)');
    containerOpts = { cardShortLink, cardId, branchName, prompt, executeModel, isFollowUp: false, doneListId: job.data.doneListId };
  }

  if (job.data.doingListId) {
    await moveCardToList(cardId, job.data.doingListId).catch((err) =>
      log.warn({ err }, 'Failed to move card to Doing list — continuing'),
    );
    log.info({ doingListId: job.data.doingListId }, 'Moved card to Doing list');
  }

  // Create a log session and post the live-log URL as a Trello comment
  const logSession = await createLogSession(cardShortLink, cardId, cardName);
  if (config.server.webhookBaseUrl) {
    const logUrl = `${config.server.webhookBaseUrl}/logs/${logSession.token}`;
    await postTrelloComment(cardId, `🔗 Live worker logs: ${logUrl}`).catch((err) =>
      log.warn({ err }, 'Failed to post log URL comment'),
    );
    log.info({ logUrl }, 'Posted live log URL to Trello');
  }

  const abortController = new AbortController();
  activeNewTaskJobs.set(cardShortLink, abortController);
  containerOpts = { ...containerOpts, signal: abortController.signal };

  try {
    log.info({ planMode, planModel, executeModel }, 'Handing off to container backend — starting worker container');
    const startTime = Date.now();

    const { exitCode, logs } = await runTaskInContainer(containerOpts);

    const durationMs = Date.now() - startTime;
    log.info(
      { exitCode, logBytes: logs.length, durationMs, durationMin: Math.round(durationMs / 60_000) },
      'Worker container finished',
    );

    if (exitCode !== 0) {
      if (cancelledCards.has(cardShortLink)) {
        cancelledCards.delete(cardShortLink);
        log.info({ exitCode }, 'Worker exited non-zero but card was cancelled — suppressing failure comment');
        return;
      }
      log.warn({ exitCode }, 'Worker exited with non-zero code — posting failure comment to Trello');
      const tail = logs.split('\n').filter(l => l.trim()).slice(-50).join('\n');
      await postTrelloComment(
        cardId,
        `❌ Claude exited with code ${exitCode}.\n\nLast output:\n\`\`\`\n${tail}\n\`\`\``,
      ).catch(() => {});
      // Do NOT throw — Claude exiting non-zero is an intentional signal, not a transient error.
      // Throwing would cause BullMQ to retry, wasting API credits on the same broken state.
      return;
    }

    log.info({ durationMin: Math.round(durationMs / 60_000) }, 'New task completed successfully');
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.info('new-task container killed by incoming feedback — suppressing failure comment');
      return;
    }
    if (cancelledCards.has(cardShortLink)) {
      cancelledCards.delete(cardShortLink);
      log.info('new-task errored but card was cancelled — suppressing');
      return;
    }
    log.error({ err }, 'new-task job failed');
    throw err;
  } finally {
    if (activeNewTaskJobs.get(cardShortLink) === abortController) {
      activeNewTaskJobs.delete(cardShortLink);
    }
  }
}

async function handleFeedback(job: Job<FeedbackJob>): Promise<void> {
  const { cardId, cardShortLink, cardName, cardUrl, commentText, commenterName, boardId } = job.data;
  const log = logger.child({ phase: 'queue', jobId: job.id, cardId, cardShortLink });

  log.info(
    { commenter: commenterName, commentLength: commentText.length, attempt: job.attemptsMade + 1 },
    'Picked up feedback job',
  );

  // Fetch board lists for guard (used to offer move targets) — non-fatal if it fails
  let boardLists: { id: string; name: string }[] = [];
  try {
    boardLists = await fetchBoardLists(boardId);
  } catch (err) {
    log.warn({ err }, 'Failed to fetch board lists for guard — continuing without list context');
  }

  // Guard: classify the comment before aborting any existing job.
  // Casual human comments must not kill running work.
  const guardResult = await classifyComment(commentText, commenterName, cardName, boardLists);

  if (guardResult.type === 'ignore') {
    log.info({ commenter: commenterName }, 'Guard determined comment is not for the agent — skipping');
    return;
  }

  if (guardResult.type === 'operation') {
    log.info({ commenter: commenterName, action: guardResult.action, target: guardResult.target }, 'Guard detected operational command — executing inline');
    await executeOperation(guardResult, job.data, boardLists, { cancelledCards, activeNewTaskJobs, activeFeedbackJobs, taskQueue });
    return;
  }

  // type === 'feedback' — kill any in-flight work and spin up a container
  // Kill any in-flight new-task container — feedback supersedes the original task.
  const runningNewTask = activeNewTaskJobs.get(cardShortLink);
  if (runningNewTask) {
    log.info('Aborting in-flight new-task container — feedback comment takes over');
    runningNewTask.abort();
  }

  // Abort any in-flight feedback job for this card — the newest comment supersedes it.
  const existing = activeFeedbackJobs.get(cardShortLink);
  if (existing) {
    log.info('Aborting previous feedback job — newer comment will be processed instead');
    existing.abort();
  }
  const abortController = new AbortController();
  activeFeedbackJobs.set(cardShortLink, abortController);

  const branchName = `claude/${cardShortLink}`;
  const repos = getBoardRepos(boardId);
  log.info({ branchName, repos }, 'Resolved branch and repos for feedback');

  const prompt = buildFeedbackPrompt({ cardId, cardShortLink, cardUrl, commentText, commenterName, repos, imageDir: '/workspace/.card-images', doneListId: job.data.doneListId }, config.agent.prompts.feedback);
  log.info({ promptLength: prompt.length }, 'Built feedback prompt');

  if (job.data.doingListId) {
    await moveCardToList(cardId, job.data.doingListId).catch((err) =>
      log.warn({ err }, 'Failed to move card to Doing list — continuing'),
    );
    log.info({ doingListId: job.data.doingListId }, 'Moved card to Doing list');
  }

  // Create a log session and post the live-log URL as a Trello comment
  const logSession = await createLogSession(cardShortLink, cardId, cardName);
  if (config.server.webhookBaseUrl) {
    const logUrl = `${config.server.webhookBaseUrl}/logs/${logSession.token}`;
    await postTrelloComment(cardId, `🔗 Live worker logs: ${logUrl}`).catch((err) =>
      log.warn({ err }, 'Failed to post log URL comment'),
    );
    log.info({ logUrl }, 'Posted live log URL to Trello');
  }

  try {
    log.info('Handing off to container backend — starting worker container for feedback');
    const startTime = Date.now();

    const { exitCode, logs } = await runTaskInContainer({
      cardShortLink,
      cardId,
      branchName,
      prompt,
      executeModel: config.agent.models.execute,
      isFollowUp: true,
      doneListId: job.data.doneListId,
      signal: abortController.signal,
    });

    const durationMs = Date.now() - startTime;
    log.info(
      { exitCode, logBytes: logs.length, durationMs, durationMin: Math.round(durationMs / 60_000) },
      'Feedback worker container finished',
    );

    if (exitCode !== 0) {
      if (cancelledCards.has(cardShortLink)) {
        cancelledCards.delete(cardShortLink);
        log.info({ exitCode }, 'Feedback exited non-zero but card was cancelled — suppressing failure comment');
        return;
      }
      log.warn({ exitCode }, 'Feedback worker exited with non-zero code — posting failure comment to Trello');
      const tail = logs.split('\n').filter(l => l.trim()).slice(-50).join('\n');
      await postTrelloComment(
        cardId,
        `❌ Claude failed to process feedback (exit ${exitCode}).\n\n\`\`\`\n${tail}\n\`\`\``,
      ).catch(() => {});
      // Do NOT throw — Claude exiting non-zero is intentional, not transient.
      // Retrying would waste API credits on the same state.
      return;
    }

    log.info({ durationMin: Math.round(durationMs / 60_000) }, 'Feedback processed successfully');
  } catch (err) {
    // Suppress failure comment when this job was superseded by a newer feedback comment
    if ((err as Error).name === 'AbortError') {
      log.info('Feedback job was superseded by a newer comment — suppressing failure comment');
      return;
    }
    if (cancelledCards.has(cardShortLink)) {
      cancelledCards.delete(cardShortLink);
      log.info('feedback errored but card was cancelled — suppressing');
      return;
    }
    log.error({ err }, 'feedback job failed');
    throw err;
  } finally {
    // Clean up the map entry only if we're still the active job for this card
    if (activeFeedbackJobs.get(cardShortLink) === abortController) {
      activeFeedbackJobs.delete(cardShortLink);
    }
  }
}

async function handleCleanup(job: Job<CleanupJob>): Promise<void> {
  const { cardShortLink, prUrl, reason, repoFullName } = job.data;
  const log = logger.child({ phase: 'cleanup', jobId: job.id, cardShortLink });

  log.info({ prUrl, reason, repoFullName }, 'Picked up cleanup job');

  if (reason === 'archived') {
    // Card was archived — stop everything immediately without checking open PRs
    cancelledCards.add(cardShortLink);
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
      log.warn({ err }, 'Failed to drain queued jobs — continuing with cleanup');
    }
  } else {
    // PR closed/merged — skip cleanup if other PRs are still open on this branch
    const branch = `claude/${cardShortLink}`;
    const repoSlugs = getAllRepoSlugs();
    if (repoSlugs.length > 0) {
      try {
        const openPRs = await findOpenPRsForBranch(branch, repoSlugs);
        if (openPRs.length > 0) {
          log.info({ openPRs }, 'Skipping cleanup — other PRs still open on this branch');
          return;
        }
      } catch (err) {
        log.warn({ err }, 'Failed to check for open PRs — proceeding with cleanup as safety fallback');
      }
    }
  }

  log.info({ prUrl, reason }, 'Destroying container and volume');
  await destroyTaskContainer(cardShortLink);
  await removeLogSessionByCard(cardShortLink);
  log.info({ prUrl, reason }, 'Cleanup complete — container and volume destroyed');
}

async function handleCancel(job: Job<CancelJob>): Promise<void> {
  const { cardId, cardShortLink } = job.data;
  const log = logger.child({ phase: 'cancel', jobId: job.id, cardId, cardShortLink });

  log.info('Picked up cancel job — bot was removed from card');

  // Mark as cancelled so any concurrently-running task suppresses its failure comment
  cancelledCards.add(cardShortLink);

  // Drain any queued/delayed new-task or feedback jobs for this card
  try {
    const pending = await taskQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    for (const j of pending) {
      const d = j.data as { cardShortLink?: string };
      if (d.cardShortLink === cardShortLink && (j.name === 'new-task' || j.name === 'feedback')) {
        await j.remove();
        log.info({ jobId: j.id, jobName: j.name }, 'Removed queued job for cancelled card');
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to drain queued jobs — continuing with cleanup');
  }

  // Stop and destroy the container/volume (works for both Docker and Kubernetes)
  log.info('Destroying container and volume');
  await destroyTaskContainer(cardShortLink);
  log.info('Container and volume destroyed');

  // Notify on card
  await postTrelloComment(
    cardId,
    '🛑 Claude was removed from this card — work has been stopped and cleaned up.',
  ).catch((err) => log.warn({ err }, 'Failed to post cancellation comment'));

  log.info('Cancel complete');
}

worker.on('completed', (job) => {
  logger.info({ phase: 'queue', jobId: job.id, jobName: job.name }, 'Job completed');
});

worker.on('failed', (job, err) => {
  logger.error(
    { phase: 'queue', jobId: job?.id, jobName: job?.name, attempt: job?.attemptsMade, err },
    'Job failed',
  );
});

export async function gracefulShutdown(): Promise<void> {
  await worker.close();
}

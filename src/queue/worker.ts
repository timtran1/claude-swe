import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { taskQueue } from './queue.js';
import { logger } from '../logger.js';
import { runTaskInContainer, destroyTaskContainer } from '../containers/manager.js';
import { buildPlanPrompt, buildExecutePrompt, buildFeedbackPrompt } from '../agent/prompt.js';
import { getBoardRepos } from '../workspace/repo.js';
import { postTrelloComment, moveCardToList } from '../trello/api.js';
import type { NewTaskJob, FeedbackJob, CleanupJob, CancelJob } from '../webhook/types.js';

const connection = {
  host: config.redis.host,
  port: config.redis.port,
};

// Cards that have been explicitly cancelled (bot removed mid-flight).
// Used to suppress spurious failure comments when a container is killed by cancellation.
const cancelledCards = new Set<string>();

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

  const branchName = `claude/${cardShortLink}`;
  const repos = getBoardRepos(boardId);
  log.info({ branchName, repos }, 'Resolved branch and repos for task');

  const promptOpts = { cardId, cardName, cardUrl, repos, imageDir: '/workspace/.card-images' };
  const planPrompt = buildPlanPrompt(promptOpts);
  const executePrompt = buildExecutePrompt(promptOpts);
  log.info({ planPromptLength: planPrompt.length, executePromptLength: executePrompt.length }, 'Built two-phase prompts');

  if (job.data.doingListId) {
    await moveCardToList(cardId, job.data.doingListId).catch((err) =>
      log.warn({ err }, 'Failed to move card to Doing list — continuing'),
    );
    log.info({ doingListId: job.data.doingListId }, 'Moved card to Doing list');
  }

  try {
    log.info('Handing off to container backend — starting worker container (Opus plan → Sonnet execute)');
    const startTime = Date.now();

    const { exitCode, logs } = await runTaskInContainer({
      cardShortLink,
      cardId,
      branchName,
      planPrompt,
      executePrompt,
      isFollowUp: false,
      doneListId: job.data.doneListId,
    });

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
      const tail = logs.split('\n').slice(-20).join('\n');
      await postTrelloComment(
        cardId,
        `❌ Claude exited with code ${exitCode}.\n\nLast output:\n\`\`\`\n${tail}\n\`\`\``,
      ).catch(() => {});
      throw new Error(`Worker container exited with code ${exitCode}`);
    }

    log.info({ durationMin: Math.round(durationMs / 60_000) }, 'New task completed successfully');
  } catch (err) {
    log.error({ err }, 'new-task job failed');
    throw err;
  }
}

async function handleFeedback(job: Job<FeedbackJob>): Promise<void> {
  const { cardId, cardShortLink, cardUrl, commentText, commenterName, boardId } = job.data;
  const log = logger.child({ phase: 'queue', jobId: job.id, cardId, cardShortLink });

  log.info(
    { commenter: commenterName, commentLength: commentText.length, attempt: job.attemptsMade + 1 },
    'Picked up feedback job',
  );

  const branchName = `claude/${cardShortLink}`;
  const repos = getBoardRepos(boardId);
  log.info({ branchName, repos }, 'Resolved branch and repos for feedback');

  const prompt = buildFeedbackPrompt({ cardId, cardUrl, commentText, commenterName, repos });
  log.info({ promptLength: prompt.length }, 'Built feedback prompt');

  if (job.data.doingListId) {
    await moveCardToList(cardId, job.data.doingListId).catch((err) =>
      log.warn({ err }, 'Failed to move card to Doing list — continuing'),
    );
    log.info({ doingListId: job.data.doingListId }, 'Moved card to Doing list');
  }

  try {
    log.info('Handing off to container backend — starting worker container for feedback');
    const startTime = Date.now();

    const { exitCode, logs } = await runTaskInContainer({
      cardShortLink,
      cardId,
      branchName,
      prompt,
      isFollowUp: true,
      doneListId: job.data.doneListId,
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
      const tail = logs.split('\n').slice(-20).join('\n');
      await postTrelloComment(
        cardId,
        `❌ Claude failed to process feedback (exit ${exitCode}).\n\n\`\`\`\n${tail}\n\`\`\``,
      ).catch(() => {});
      throw new Error(`Feedback container exited with code ${exitCode}`);
    }

    log.info({ durationMin: Math.round(durationMs / 60_000) }, 'Feedback processed successfully');
  } catch (err) {
    log.error({ err }, 'feedback job failed');
    throw err;
  }
}

async function handleCleanup(job: Job<CleanupJob>): Promise<void> {
  const { cardShortLink, prUrl, reason } = job.data;
  const log = logger.child({ phase: 'cleanup', jobId: job.id, cardShortLink });

  log.info({ prUrl, reason }, 'Picked up cleanup job — destroying container and volume');
  await destroyTaskContainer(cardShortLink);
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

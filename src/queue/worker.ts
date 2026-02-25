import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runTaskInContainer, destroyTaskContainer } from '../containers/manager.js';
import { buildNewTaskPrompt, buildFeedbackPrompt } from '../agent/prompt.js';
import { getBoardRepos } from '../workspace/repo.js';
import { postTrelloComment } from '../trello/api.js';
import type { NewTaskJob, FeedbackJob, CleanupJob } from '../webhook/types.js';

const connection = {
  host: config.redis.host,
  port: config.redis.port,
};

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
      default:
        logger.warn({ jobName: job.name }, 'Unknown job type — skipping');
    }
  },
  { connection, concurrency: 2 },
);

async function handleNewTask(job: Job<NewTaskJob>): Promise<void> {
  const { cardId, cardShortLink, cardName, cardUrl, boardId } = job.data;
  const log = logger.child({ phase: 'queue', jobId: job.id, cardId, cardShortLink, cardName });

  log.info({ attempt: job.attemptsMade + 1, maxAttempts: job.opts?.attempts ?? 1 }, 'Picked up new-task job');

  const branchName = `claude/${cardShortLink}`;
  const repos = getBoardRepos(boardId);
  log.info({ branchName, repos }, 'Resolved branch and repos for task');

  const prompt = buildNewTaskPrompt({
    cardId,
    cardName,
    cardUrl,
    repos,
    imageDir: '/workspace/.card-images',
  });
  log.info({ promptLength: prompt.length }, 'Built new-task prompt');

  try {
    log.info('Handing off to container backend — starting worker container');
    const startTime = Date.now();

    const { exitCode, logs } = await runTaskInContainer({
      cardShortLink,
      cardId,
      branchName,
      prompt,
      isFollowUp: false,
      doneListId: job.data.doneListId,
    });

    const durationMs = Date.now() - startTime;
    log.info(
      { exitCode, logBytes: logs.length, durationMs, durationMin: Math.round(durationMs / 60_000) },
      'Worker container finished',
    );

    if (exitCode !== 0) {
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

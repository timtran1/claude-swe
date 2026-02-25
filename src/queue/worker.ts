import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runTaskInContainer, destroyTaskContainer } from '../containers/manager.js';
import { buildNewTaskPrompt, buildFeedbackPrompt } from '../agent/prompt.js';
import { extractRepoUrl } from '../workspace/repo.js';
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
  const { cardId, cardShortLink, cardName, cardDesc, cardUrl } = job.data;
  const log = logger.child({ cardId, cardName });

  log.info('Starting new-task job');

  // Determine which repo to work on
  const repoUrl = extractRepoUrl(cardDesc);
  if (!repoUrl) {
    const msg = 'Could not determine target repo. Add `repo: https://github.com/org/name` to the card description, or set DEFAULT_GITHUB_REPO.';
    await postTrelloComment(cardId, `❌ ${msg}`).catch(() => {});
    throw new Error(msg);
  }

  const branchName = `claude/${cardShortLink}`;

  const prompt = buildNewTaskPrompt({
    cardId,
    cardName,
    cardUrl,
  });

  try {
    const { exitCode, logs } = await runTaskInContainer({
      cardShortLink,
      repoUrl,
      branchName,
      prompt,
      isFollowUp: false,
      doneListId: job.data.doneListId,
    });

    if (exitCode !== 0) {
      const tail = logs.split('\n').slice(-20).join('\n');
      await postTrelloComment(
        cardId,
        `❌ Claude exited with code ${exitCode}.\n\nLast output:\n\`\`\`\n${tail}\n\`\`\``,
      ).catch(() => {});
      throw new Error(`Worker container exited with code ${exitCode}`);
    }

    log.info('New task completed successfully');
  } catch (err) {
    log.error({ err }, 'new-task job failed');
    throw err;
  }
}

async function handleFeedback(job: Job<FeedbackJob>): Promise<void> {
  const { cardId, cardShortLink, cardUrl, commentText, commenterName } = job.data;
  const log = logger.child({ cardId });

  log.info({ commenter: commenterName }, 'Starting feedback job');

  const branchName = `claude/${cardShortLink}`;

  // Determine repo URL — we need it even for follow-ups in case volume was lost
  const repoUrl = extractRepoUrl(job.data.cardDesc ?? '');
  if (!repoUrl) {
    await postTrelloComment(cardId, '❌ Cannot process feedback — no repo URL found on card.').catch(() => {});
    throw new Error('No repo URL for feedback job');
  }

  const prompt = buildFeedbackPrompt({ cardId, cardUrl, commentText, commenterName });

  try {
    const { exitCode, logs } = await runTaskInContainer({
      cardShortLink,
      repoUrl,
      branchName,
      prompt,
      isFollowUp: true,
      doneListId: job.data.doneListId,
    });

    if (exitCode !== 0) {
      const tail = logs.split('\n').slice(-20).join('\n');
      await postTrelloComment(
        cardId,
        `❌ Claude failed to process feedback (exit ${exitCode}).\n\n\`\`\`\n${tail}\n\`\`\``,
      ).catch(() => {});
      throw new Error(`Feedback container exited with code ${exitCode}`);
    }

    log.info('Feedback processed successfully');
  } catch (err) {
    log.error({ err }, 'feedback job failed');
    throw err;
  }
}

async function handleCleanup(job: Job<CleanupJob>): Promise<void> {
  const { cardShortLink } = job.data;
  const log = logger.child({ cardShortLink });

  log.info('Cleaning up container and volume for closed/merged PR');
  await destroyTaskContainer(cardShortLink);
  log.info('Cleanup complete');
}

worker.on('completed', (job) => {
  logger.info({ jobId: job.id, jobName: job.name }, 'Job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, jobName: job?.name, err }, 'Job failed');
});

export async function gracefulShutdown(): Promise<void> {
  await worker.close();
}

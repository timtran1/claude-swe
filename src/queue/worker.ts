import path from 'path';
import fs from 'fs/promises';
import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { setupWorkspace, cleanupWorkspace } from '../workspace/setup.js';
import { runClaudeAgent } from '../agent/runner.js';
import { buildNewTaskPrompt, buildFeedbackPrompt } from '../agent/prompt.js';
import { fetchCardAttachments, postTrelloComment } from '../trello/api.js';
import type { NewTaskJob, FeedbackJob } from '../webhook/types.js';

const connection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
};

export const worker = new Worker(
  'tasks',
  async (job: Job) => {
    if (job.name === 'new-task') {
      await handleNewTask(job as Job<NewTaskJob>);
    } else if (job.name === 'feedback') {
      await handleFeedback(job as Job<FeedbackJob>);
    } else {
      logger.warn({ jobName: job.name }, 'Unknown job type — skipping');
    }
  },
  { connection, concurrency: 2 },
);

async function handleNewTask(job: Job<NewTaskJob>): Promise<void> {
  const { cardId, cardShortLink, cardName, cardUrl } = job.data;
  const log = logger.child({ cardId, cardName });

  log.info('Starting new-task job');

  // Download any image attachments from the card
  const imageDir = `/tmp/workspaces/${cardId}/images`;
  await fs.mkdir(imageDir, { recursive: true });

  // Determine whether we downloaded any images (scoped outside inner try)
  let hasImages = false;
  try {
    const allAttachments = await fetchCardAttachments(cardId);
    const imageAttachments = allAttachments.filter((a) =>
      /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(a.name),
    );
    hasImages = imageAttachments.length > 0;
    for (const attachment of imageAttachments) {
      const dest = path.join(imageDir, attachment.name);
      const res = await fetch(attachment.url, {
        headers: { Authorization: `OAuth oauth_consumer_key="${config.TRELLO_API_KEY}", oauth_token="${config.TRELLO_TOKEN}"` },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(dest, buf);
      log.info({ file: attachment.name }, 'Downloaded attachment');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to download some attachments — continuing');
  }

  const branchName = `claude/${cardShortLink}`;
  const workspaceDir = `/tmp/workspaces/${cardId}/repo`;

  try {
    await setupWorkspace({ workspaceDir, cardId, branchName });

    const prompt = buildNewTaskPrompt({
      cardId,
      cardName,
      cardUrl,
      imageDir: hasImages ? imageDir : undefined,
    });

    await runClaudeAgent({ workspaceDir, prompt });

    log.info('Claude Code finished successfully');
  } catch (err) {
    log.error({ err }, 'new-task job failed');
    await postTrelloComment(
      cardId,
      `❌ Claude failed to complete this task.\n\nError: ${err instanceof Error ? err.message : String(err)}`,
    ).catch(() => {});
    throw err;
  } finally {
    await cleanupWorkspace(workspaceDir).catch(() => {});
  }
}

// Keep track of which branch is associated with each card for feedback jobs
const cardBranchMap = new Map<string, string>();

async function handleFeedback(job: Job<FeedbackJob>): Promise<void> {
  const { cardId, cardShortLink, cardUrl, commentText, commenterName } = job.data;
  const log = logger.child({ cardId });

  log.info({ commenter: commenterName }, 'Starting feedback job');

  const branchName = cardBranchMap.get(cardId) ?? `claude/${cardShortLink}`;
  const workspaceDir = `/tmp/workspaces/${cardId}-feedback/repo`;

  try {
    await setupWorkspace({ workspaceDir, cardId, branchName, checkout: true });

    const prompt = buildFeedbackPrompt({ cardId, cardUrl, commentText, commenterName });

    await runClaudeAgent({ workspaceDir, prompt });

    log.info('Feedback handled successfully');
  } catch (err) {
    log.error({ err }, 'feedback job failed');
    await postTrelloComment(
      cardId,
      `❌ Claude failed to process the feedback.\n\nError: ${err instanceof Error ? err.message : String(err)}`,
    ).catch(() => {});
    throw err;
  } finally {
    await cleanupWorkspace(workspaceDir).catch(() => {});
  }
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

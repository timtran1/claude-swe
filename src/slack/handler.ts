import type { App } from '@slack/bolt';
import { logger } from '../logger.js';
import { config, getBoardConfig } from '../config.js';
import { taskQueue } from '../queue/queue.js';
import { fetchCard } from '../trello/api.js';
import { classifyComment } from '../agent/guard.js';
import { executeOperation } from '../agent/operations.js';
import { getWorkerContext } from '../queue/worker.js';
import { postSlackReply } from './client.js';
import {
  generateSlackTaskId,
  setSlackThreadTask,
  getSlackThreadTask,
  refreshSlackThreadTtl,
  setPendingSlackTask,
  getPendingSlackTask,
  deletePendingSlackTask,
} from './id.js';
import type { NewTaskJob, FeedbackJob, TaskSource, SlackFileRef } from '../webhook/types.js';

/** Parse GitHub repo URLs from message text (github.com/<owner>/<repo>) */
function extractRepoUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/g) ?? [];
  return [...new Set(matches)].map((url) => url.replace(/\/$/, ''));
}

/** Parse Trello card short links from message text (trello.com/c/<shortLink>) */
function extractTrelloShortLink(text: string): string | null {
  const match = text.match(/trello\.com\/c\/([\w]+)/);
  return match?.[1] ?? null;
}

/** Strip the bot mention (<@UXXXXXXXX>) from message text */
function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

/** Extract Slack file metadata from the event for passing to the worker container */
function extractSlackFiles(event: { files?: Array<{ id: string; name?: string; url_private?: string; mimetype?: string }> }): SlackFileRef[] {
  const files = event.files ?? [];
  return files
    .filter((f) => !!f.url_private)
    .map((f) => ({ url: f.url_private!, name: f.name ?? f.id }));
}

interface ResolvedTask {
  repos: string[];
  trelloCardId?: string;
  trelloCardUrl?: string;
}

/**
 * Attempt to resolve repos for a new task from the message.
 * Returns null if no repos could be found (task should be deferred).
 */
async function resolveTaskRepos(text: string, channelId: string): Promise<ResolvedTask | null> {
  // 1. GitHub repo URLs in the message
  const repoUrls = extractRepoUrls(text);
  if (repoUrls.length > 0) {
    return { repos: repoUrls };
  }

  // 2. Linked Trello card
  const trelloShortLink = extractTrelloShortLink(text);
  if (trelloShortLink) {
    // Find the board config for this card to get its repos
    // Try fetching the card to get its boardId, then look up the board config
    try {
      // Fetch by short link — Trello API accepts shortLinks as card IDs
      const card = await fetchCard(trelloShortLink);
      const boardCfg = getBoardConfig(card.idList) ?? config.trello.boards.find((b) =>
        // fetchCard doesn't give boardId directly, we use idList which belongs to a board.
        // Fall back to scanning — the card URL contains the shortLink so we can match.
        card.url?.includes(trelloShortLink),
      );
      const repos = boardCfg?.repos ?? [];
      return {
        repos,
        trelloCardId: card.id,
        trelloCardUrl: card.url,
      };
    } catch (err) {
      logger.warn({ err, trelloShortLink }, 'Failed to fetch Trello card for repo resolution');
      return { repos: [], trelloCardId: undefined, trelloCardUrl: `https://trello.com/c/${trelloShortLink}` };
    }
  }

  // 3. Per-channel configured repos
  const channelCfg = config.slack.channels[channelId];
  if (channelCfg?.repos && channelCfg.repos.length > 0) {
    return { repos: channelCfg.repos };
  }

  // 4. No repos found
  return null;
}

export function registerSlackHandlers(app: App): void {
  app.event('app_mention', async ({ event, say }) => {
    const log = logger.child({ phase: 'slack', channelId: event.channel, ts: event.ts });

    // Ignore messages from bots (including our own replies) to prevent loops
    if ((event as { bot_id?: string }).bot_id) {
      log.debug('Ignoring app_mention from a bot');
      return;
    }

    const text = event.text ?? '';
    const taskDescription = stripBotMention(text);
    const threadTs = (event as { thread_ts?: string }).thread_ts;
    const isTopLevel = !threadTs || threadTs === event.ts;

    if (isTopLevel) {
      // --- New task ---
      log.info({ textLength: taskDescription.length }, 'Slack mention received — new task');

      // Check if this is a reply to an existing pending task (user providing a repo URL)
      const existingPending = await getPendingSlackTask(event.channel, event.ts).catch(() => null);
      if (existingPending) {
        // This shouldn't normally happen for top-level mentions, but handle gracefully
        log.info('Existing pending task found for new top-level mention — treating as new task');
      }

      // Collect file metadata (will be downloaded inside the worker container)
      const slackFiles = extractSlackFiles(event as any);

      const taskId = generateSlackTaskId();

      // Resolve repos
      const resolved = await resolveTaskRepos(taskDescription, event.channel);

      if (!resolved) {
        // Ask user to provide a repo
        await setPendingSlackTask(event.channel, event.ts, {
          taskId,
          taskDescription,
        }).catch(() => {});

        await say({
          text: `Got it! I just need a target repo to work on.\n\nReply in this thread with a GitHub repo URL (e.g. \`https://github.com/myorg/my-app\`) or a Trello card link and I'll get started.`,
          thread_ts: event.ts,
        });
        log.info({ taskId }, 'No repo found — awaiting user reply with repo URL');
        return;
      }

      // Enqueue new-task job
      await setSlackThreadTask(event.channel, event.ts, taskId, resolved.repos).catch(() => {});

      const source: TaskSource = {
        type: 'slack',
        channelId: event.channel,
        threadTs: event.ts,
        trelloCardId: resolved.trelloCardId,
      };

      const job: NewTaskJob = {
        cardShortLink: taskId,
        cardName: taskDescription.slice(0, 80),
        cardDesc: taskDescription,
        cardUrl: resolved.trelloCardUrl ?? '',
        source,
        repos: resolved.repos,
        taskDescription,
        slackFiles: slackFiles.length > 0 ? slackFiles : undefined,
      };

      await taskQueue.add('new-task', job, { attempts: 1 });

      await say({
        text: `Starting work on this now. Task ID: \`${taskId}\`\n\nI'll post updates here as I go. Reply in this thread to give feedback.`,
        thread_ts: event.ts,
      });

      log.info({ taskId, repos: resolved.repos }, 'Enqueued new-task job from Slack');
      return;
    }

    // --- Threaded reply ---
    const parentTs = threadTs!;
    log.info({ parentTs }, 'Slack threaded reply received');

    // Check if this is a reply to a pending task waiting for a repo
    const pending = await getPendingSlackTask(event.channel, parentTs).catch(() => null);
    if (pending) {
      const repoUrls = extractRepoUrls(taskDescription);
      const trelloShortLink = extractTrelloShortLink(taskDescription);

      if (repoUrls.length === 0 && !trelloShortLink) {
        await say({
          text: `I still need a repo URL to get started. Please reply with a GitHub repo URL (e.g. \`https://github.com/myorg/my-app\`) or a Trello card link.`,
          thread_ts: parentTs,
        });
        return;
      }

      let repos = repoUrls;
      let trelloCardId: string | undefined;
      let trelloCardUrl: string | undefined;

      if (trelloShortLink && repos.length === 0) {
        try {
          const card = await fetchCard(trelloShortLink);
          const boardCfg = config.trello.boards.find((b) => card.url?.includes(trelloShortLink));
          repos = boardCfg?.repos ?? [];
          trelloCardId = card.id;
          trelloCardUrl = card.url;
        } catch (err) {
          log.warn({ err, trelloShortLink }, 'Failed to fetch Trello card');
        }
      }

      await deletePendingSlackTask(event.channel, parentTs).catch(() => {});
      await setSlackThreadTask(event.channel, parentTs, pending.taskId, repos).catch(() => {});

      const source: TaskSource = {
        type: 'slack',
        channelId: event.channel,
        threadTs: parentTs,
        trelloCardId,
      };

      const job: NewTaskJob = {
        cardShortLink: pending.taskId,
        cardName: pending.taskDescription.slice(0, 80),
        cardDesc: pending.taskDescription,
        cardUrl: trelloCardUrl ?? '',
        source,
        repos,
        taskDescription: pending.taskDescription,
      };

      await taskQueue.add('new-task', job, { attempts: 1 });

      await say({
        text: `Got it! Starting work now. Task ID: \`${pending.taskId}\`\n\nI'll post updates here as I go.`,
        thread_ts: parentTs,
      });

      log.info({ taskId: pending.taskId, repos }, 'Enqueued deferred new-task job from Slack');
      return;
    }

    // Normal threaded reply — look up existing task
    const threadData = await getSlackThreadTask(event.channel, parentTs).catch(() => null);
    if (!threadData) {
      log.info({ parentTs }, 'No task found for this Slack thread — ignoring reply');
      return;
    }

    const { taskId, repos } = threadData;

    // Refresh TTL
    await refreshSlackThreadTtl(event.channel, parentTs, taskId).catch(() => {});

    const source: TaskSource = {
      type: 'slack',
      channelId: event.channel,
      threadTs: parentTs,
    };

    // Guard: classify before touching the queue.
    const guardResult = await classifyComment(taskDescription, event.user ?? 'unknown', taskDescription.slice(0, 80), []);

    if (guardResult.type === 'ignore') {
      log.info({ taskId }, 'Guard: Slack reply is not for the agent — ignoring');
      return;
    }

    const jobData: FeedbackJob = {
      cardShortLink: taskId,
      cardName: taskDescription.slice(0, 80),
      cardDesc: '',
      cardUrl: '',
      commentText: taskDescription,
      commenterName: event.user ?? 'unknown',
      source,
      repos,
    };

    if (guardResult.type === 'operation') {
      log.info({ taskId, action: guardResult.action, target: guardResult.target }, 'Guard: operational command — executing inline');
      await executeOperation(guardResult, jobData, [], getWorkerContext());
      return;
    }

    // Collect file metadata from the reply (only for genuine feedback)
    const slackFiles = extractSlackFiles(event as any);
    if (slackFiles.length > 0) {
      jobData.slackFiles = slackFiles;
    }

    await taskQueue.add('feedback', jobData, { attempts: 1 });

    log.info({ taskId }, 'Guard: feedback — enqueued feedback job from Slack');

    await postSlackReply(event.channel, parentTs, `Got your feedback. Working on it now...`).catch(() => {});
  });
}

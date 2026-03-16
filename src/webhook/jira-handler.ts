import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { taskQueue } from '../queue/queue.js';
import { jiraBotAccountId } from '../jira/bot.js';
import { addJiraComment, getJiraTransitions } from '../jira/api.js';
import { adfToPlainText } from '../jira/adf.js';
import { resolveJiraTransitionId } from '../jira/api.js';
import { resolveJiraConfig } from '../jira/config.js';
import { classifyComment } from '../agent/guard.js';
import { executeOperation } from '../agent/operations.js';
import { getWorkerContext } from '../queue/worker.js';
import type {
  JiraWebhookPayload,
  NewTaskJob,
  FeedbackJob,
  CancelJob,
  CleanupJob,
} from './types.js';

// --- Signature verification ---

/**
 * Verify a Jira webhook HMAC-SHA256 signature.
 * Jira signs the raw body with the webhook secret configured at registration time.
 * Returns true (with a warning) if no secret is configured.
 */
function verifyJiraWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = config.jira.webhookSecret;
  if (!secret) {
    logger.warn({ phase: 'webhook:jira' }, 'Jira webhookSecret not configured — skipping signature verification');
    return true;
  }
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// --- Express handler ---

/**
 * Express route handler for POST /webhooks/jira.
 * Verifies the HMAC signature, responds 200 immediately, then routes the event asynchronously.
 */
export function handleJiraWebhook(req: Request, res: Response): void {
  const signature = req.headers['x-hub-signature'] as string | undefined;
  const rawBody: Buffer = (req as Request & { rawBody: Buffer }).rawBody;

  if (signature && !verifyJiraWebhookSignature(rawBody, signature)) {
    logger.warn({ phase: 'webhook:jira' }, 'Jira webhook signature verification failed');
    res.sendStatus(401);
    return;
  }

  const payload = req.body as JiraWebhookPayload;

  if (!payload?.webhookEvent || !payload?.issue) {
    logger.info({ phase: 'webhook:jira' }, 'Jira webhook received with no event or issue — acknowledging');
    res.sendStatus(200);
    return;
  }

  logger.info(
    { phase: 'webhook:jira', event: payload.webhookEvent, issueKey: payload.issue.key },
    'Jira webhook received',
  );

  // Respond immediately; process asynchronously to avoid Jira retry storms
  res.sendStatus(200);

  routeJiraEvent(payload).catch((err) => {
    logger.error({ err, phase: 'webhook:jira', event: payload.webhookEvent }, 'Failed to route Jira webhook event');
  });
}

// --- Event routing ---

/**
 * Route a parsed Jira webhook payload to the appropriate job or inline action.
 */
async function routeJiraEvent(payload: JiraWebhookPayload): Promise<void> {
  const { webhookEvent, issue, comment, changelog, user } = payload;
  const issueKey = issue.key;
  const issueId = issue.id;
  const projectKey = issue.fields.project.key;
  const projectId = issue.fields.project.id;
  const log = logger.child({ phase: 'webhook:jira', issueKey, event: webhookEvent });

  // --- a. Issue assigned to bot ---
  if (webhookEvent === 'jira:issue_updated' && changelog) {
    const assigneeChange = changelog.items.find((item) => item.field === 'assignee');

    if (assigneeChange) {
      const newAssigneeId = assigneeChange.to;
      const oldAssigneeId = assigneeChange.from;

      // Bot was assigned
      if (jiraBotAccountId && newAssigneeId === jiraBotAccountId) {
        log.info({ projectKey }, 'Bot assigned to issue — processing new task');
        await handleBotAssigned({ issue, issueKey, issueId, projectKey, projectId, log });
        return;
      }

      // Bot was unassigned
      if (jiraBotAccountId && oldAssigneeId === jiraBotAccountId) {
        log.info('Bot unassigned from issue — enqueueing cancel job');
        const job: CancelJob = {
          cardShortLink: issueKey,
          source: { type: 'jira', issueId, issueKey, projectId },
        };
        await taskQueue.add('cancel', job);
        return;
      }
    }

    // Issue deleted or moved to a done/closed category via status change
    const statusChange = changelog.items.find((item) => item.field === 'status');
    if (statusChange) {
      const newStatus = (statusChange.toString ?? '').toLowerCase();
      if (/^(done|closed|resolved|cancelled|canceled)$/.test(newStatus)) {
        // Only clean up if bot is still (or was) assigned
        const assigneeId = issue.fields.assignee?.accountId;
        if (!jiraBotAccountId || assigneeId === jiraBotAccountId) {
          log.info({ newStatus }, 'Issue moved to terminal status — enqueueing cleanup job');
          const job: CleanupJob = {
            cardShortLink: issueKey,
            reason: 'archived',
            source: { type: 'jira', issueId, issueKey, projectId },
          };
          await taskQueue.add('cleanup', job);
          return;
        }
      }
    }
  }

  // --- b. Comment added ---
  if (webhookEvent === 'comment_created' && comment) {
    const assigneeId = issue.fields.assignee?.accountId;

    // Only process comments on bot-assigned issues
    if (!jiraBotAccountId || assigneeId !== jiraBotAccountId) {
      log.info({ assigneeId, jiraBotAccountId }, 'Issue not assigned to bot — ignoring comment');
      return;
    }

    // Ignore bot's own comments to prevent feedback loops
    if (comment.author.accountId === jiraBotAccountId) {
      log.info('Ignoring comment from bot itself');
      return;
    }

    const resolvedConfig = resolveJiraConfig(projectKey, issue.fields.description);

    // Apply per-project status filter
    if (resolvedConfig.includeStatuses.length > 0) {
      const currentStatus = issue.fields.status.name.toLowerCase();
      const allowed = resolvedConfig.includeStatuses.map((s) => s.toLowerCase());
      if (!allowed.includes(currentStatus)) {
        log.info({ currentStatus, allowed }, 'Issue status not in includeStatuses filter — ignoring comment');
        return;
      }
    }

    // comment.body is ADF when it's an object; plain string on older webhook payloads
    const commentText = typeof comment.body === 'string'
      ? comment.body
      : adfToPlainText(comment.body);
    const commenterName = comment.author.displayName;
    const cardName = issue.fields.summary;

    // Fetch transitions for the guard's "available lists" parameter (enables OP:move)
    const transitions = await getJiraTransitions(issueKey).catch(() => [] as { id: string; name: string }[]);
    const guardResult = await classifyComment(
      commentText,
      commenterName,
      cardName,
      transitions, // transition names stand in for board lists for Jira
      // Jira-specific hint: the bot is the sole assignee; comments are almost always
      // directed at the agent. Only ignore obvious automated system messages.
      'This is a Jira issue with the AI agent as the sole assignee. Unless the comment is clearly an automated system notification or explicitly addressed to another human, classify it as FEEDBACK.',
    );

    if (guardResult.type === 'ignore') {
      log.info({ commenter: commenterName }, 'Guard: comment is not for the agent — ignoring');
      return;
    }

    const cardUrl = `${config.jira.host ?? ''}/browse/${issueKey}`;
    const feedbackJob: FeedbackJob = {
      cardShortLink: issueKey,
      cardName,
      cardUrl,
      cardDesc: adfToPlainText(issue.fields.description),
      commentText,
      commenterName,
      repos: resolvedConfig.repos,
      source: { type: 'jira', issueId, issueKey, projectId },
    };

    if (guardResult.type === 'operation') {
      log.info({ action: guardResult.action, target: guardResult.target }, 'Guard: operational command — executing inline');
      await executeOperation(guardResult, feedbackJob, transitions, getWorkerContext());
      return;
    }

    await taskQueue.add('feedback', feedbackJob, { attempts: 1 });
    log.info({ commenter: commenterName }, 'Guard: feedback — enqueued feedback job');
    return;
  }

  // --- d. Issue deleted ---
  if (webhookEvent === 'jira:issue_deleted') {
    const assigneeId = issue.fields.assignee?.accountId;
    if (!jiraBotAccountId || assigneeId === jiraBotAccountId) {
      log.info('Issue deleted — enqueueing cleanup job');
      const job: CleanupJob = {
        cardShortLink: issueKey,
        reason: 'archived',
        source: { type: 'jira', issueId, issueKey, projectId },
      };
      await taskQueue.add('cleanup', job);
    }
    return;
  }

  log.info({ event: webhookEvent }, 'Unhandled Jira webhook event — ignoring');
}

// --- Bot assigned handler ---

interface BotAssignedContext {
  issue: JiraWebhookPayload['issue'];
  issueKey: string;
  issueId: string;
  projectKey: string;
  projectId: string;
  log: Logger;
}

/**
 * Handle the case where the bot is assigned to a Jira issue.
 * Resolves config, filters by status, checks for repos, resolves transition IDs,
 * then enqueues a new-task job.
 */
async function handleBotAssigned({
  issue,
  issueKey,
  issueId,
  projectKey,
  projectId,
  log,
}: BotAssignedContext): Promise<void> {
  const resolvedConfig = resolveJiraConfig(projectKey, issue.fields.description);

  // Apply per-project status filter (empty list = all statuses allowed)
  if (resolvedConfig.includeStatuses.length > 0) {
    const currentStatus = issue.fields.status.name.toLowerCase();
    const allowed = resolvedConfig.includeStatuses.map((s) => s.toLowerCase());
    if (!allowed.includes(currentStatus)) {
      log.info({ currentStatus, allowed }, 'Issue status not in includeStatuses filter — skipping');
      return;
    }
  }

  // No repos found → ask user and bail out without enqueueing
  if (resolvedConfig.repos.length === 0) {
    log.info('No repos found for issue — posting comment asking user to add repo: <url>');
    await addJiraComment(
      issueKey,
      `Hi! I was assigned to this issue but couldn't find a repository to work on.\n\n` +
      `Please add a line like the following to the issue description and re-assign me:\n\n` +
      `  repo: https://github.com/your-org/your-repo\n\n` +
      `You can add multiple repos if needed.`,
    ).catch((err) => log.warn({ err }, 'Failed to post "no repo" comment on Jira issue'));
    return;
  }

  // Resolve transition IDs upfront — requires issue context (available transitions depend on current status)
  const [doingTransitionId, doneTransitionId] = await Promise.all([
    resolveJiraTransitionId(issueKey, resolvedConfig.doing),
    resolveJiraTransitionId(issueKey, resolvedConfig.done),
  ]);

  const cardUrl = `${config.jira.host ?? ''}/browse/${issueKey}`;

  const job: NewTaskJob = {
    cardShortLink: issueKey,
    cardName: issue.fields.summary,
    cardDesc: adfToPlainText(issue.fields.description),
    cardUrl,
    repos: resolvedConfig.repos,
    source: { type: 'jira', issueId, issueKey, projectId },
    jiraDoingTransitionId: doingTransitionId ?? undefined,
    jiraDoneTransitionId: doneTransitionId ?? undefined,
  };

  await taskQueue.add('new-task', job, { attempts: 3 });

  log.info(
    {
      repos: resolvedConfig.repos,
      jiraDoingTransitionId: doingTransitionId,
      jiraDoneTransitionId: doneTransitionId,
    },
    'Enqueued new-task job for Jira issue',
  );
}

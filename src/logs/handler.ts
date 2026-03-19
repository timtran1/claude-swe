import type { Request, Response } from 'express';
import { config } from '../config.js';
import { getLogSession } from './store.js';
import { renderLogViewer } from './viewer.js';
import { streamWorkerLogs } from '../containers/manager.js';

/**
 * Build a list of secret values that must never appear in streamed logs.
 * Only includes values that are actually configured (non-null, non-empty).
 */
function buildSecretList(): string[] {
  return [
    config.github.token,
    config.anthropic.apiKey,
    config.trello.token,
    config.trello.apiKey,
    config.trello.apiSecret,
    config.jira.apiToken,
    config.jira.webhookSecret,
    config.slack.botToken,
    config.slack.appToken,
    config.slack.signingSecret,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
}

const SECRETS = buildSecretList();

/** Replace any known secret values in a log line with [REDACTED]. */
function redactSecrets(line: string): string {
  let result = line;
  for (const secret of SECRETS) {
    // Escape for use in regex — secrets can contain special chars
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }
  return result;
}

export async function handleLogViewer(req: Request, res: Response): Promise<void> {
  const session = await getLogSession(req.params.token as string);
  if (!session) {
    res.status(404).send('Log session not found or has expired.');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLogViewer(session.cardName, session.token));
}

export async function handleLogStream(req: Request, res: Response): Promise<void> {
  const session = await getLogSession(req.params.token as string);
  if (!session) {
    res.status(404).end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  await streamWorkerLogs(
    session.cardShortLink,
    (line) => {
      if (!closed) res.write(`event: log\ndata: ${redactSecrets(line)}\n\n`);
    },
    () => {
      if (!closed) {
        res.write('event: done\ndata: \n\n');
        res.end();
      }
    },
  );
}

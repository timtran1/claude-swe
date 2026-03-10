import type { Request, Response } from 'express';
import { getLogSession } from './store.js';
import { renderLogViewer } from './viewer.js';
import { streamWorkerLogs } from '../containers/manager.js';

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
      if (!closed) res.write(`event: log\ndata: ${line}\n\n`);
    },
    () => {
      if (!closed) {
        res.write('event: done\ndata: \n\n');
        res.end();
      }
    },
  );
}

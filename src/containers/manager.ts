import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ContainerBackend, RunTaskOptions, WorkerInfo } from './backend.js';
import { DockerBackend } from './docker.js';
import { KubernetesBackend } from './kubernetes.js';

function createBackend(): ContainerBackend {
  switch (config.containers.backend) {
    case 'kubernetes':
      logger.info('Using Kubernetes container backend');
      return new KubernetesBackend();
    default:
      logger.info('Using Docker container backend');
      return new DockerBackend();
  }
}

const backend = createBackend();

// Re-export with original function signatures so queue/worker.ts and index.ts are unchanged.

export function runTaskInContainer(opts: RunTaskOptions): Promise<{ exitCode: number; logs: string }> {
  logger.info(
    { phase: 'container', cardShortLink: opts.cardShortLink, isFollowUp: opts.isFollowUp },
    'Delegating runTask to container backend',
  );
  return backend.runTask(opts);
}

export function destroyTaskContainer(cardShortLink: string): Promise<void> {
  logger.info({ phase: 'cleanup', cardShortLink }, 'Delegating destroyTask to container backend');
  return backend.destroyTask(cardShortLink);
}

export function listWorkerContainers(): Promise<WorkerInfo[]> {
  return backend.listWorkers();
}

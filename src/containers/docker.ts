import Docker from 'dockerode';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ContainerBackend, RunTaskOptions, WorkerInfo } from './backend.js';

const CONTAINER_PREFIX = 'claude-swe-';
const LABEL_KEY = 'claude-swe';
const CARD_LABEL = 'claude-swe.card';

export class DockerBackend implements ContainerBackend {
  private docker = new Docker({ socketPath: '/var/run/docker.sock' });

  private containerName(cardShortLink: string): string {
    return `${CONTAINER_PREFIX}${cardShortLink}`;
  }

  private volumeName(cardShortLink: string): string {
    return `${CONTAINER_PREFIX}vol-${cardShortLink}`;
  }

  async runTask(opts: RunTaskOptions): Promise<{ exitCode: number; logs: string }> {
    const { cardShortLink, cardId, prompt, doneListId } = opts;
    const name = this.containerName(cardShortLink);
    const vol = this.volumeName(cardShortLink);
    const log = logger.child({ phase: 'container', backend: 'docker', container: name });

    // Ensure the volume exists
    try {
      await this.docker.getVolume(vol).inspect();
      log.info({ volume: vol }, 'Reusing existing volume');
    } catch {
      await this.docker.createVolume({ Name: vol });
      log.info({ volume: vol }, 'Created new volume');
    }

    // Remove any previous container with the same name
    try {
      const old = this.docker.getContainer(name);
      const info = await old.inspect();
      if (info.State.Running) {
        log.info('Stopping previous running container');
        await old.stop({ t: 10 });
      }
      await old.remove({ force: true });
      log.info('Removed previous container');
    } catch {
      // No existing container — that's fine
    }

    const image = config.containers.workerImage;
    const memoryMb = 4 * 1024;
    const shmMb = 256;
    log.info(
      {
        image,
        memoryMb,
        shmMb,
        volume: vol,
        envVars: ['CLAUDE_PROMPT', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN', 'CARD_ID', 'TRELLO_DONE_LIST_ID', 'CI', 'TERM'],
      },
      'Creating worker container',
    );

    const container = await this.docker.createContainer({
      name,
      Image: image,
      Env: [
        `CLAUDE_PROMPT=${prompt}`,
        `ANTHROPIC_API_KEY=${config.anthropic.apiKey ?? ''}`,
        `GITHUB_TOKEN=${config.github.token ?? ''}`,
        `TRELLO_API_KEY=${config.trello.apiKey ?? ''}`,
        `TRELLO_TOKEN=${config.trello.token ?? ''}`,
        `CARD_ID=${cardId}`,
        `TRELLO_DONE_LIST_ID=${doneListId ?? ''}`,
        'CI=1',
        'TERM=dumb',
      ],
      HostConfig: {
        Binds: [`${vol}:/workspace`],
        Memory: memoryMb * 1024 * 1024,
        ShmSize: shmMb * 1024 * 1024,
      },
      Labels: {
        [LABEL_KEY]: 'worker',
        [CARD_LABEL]: cardShortLink,
      },
    });

    log.info('Starting worker container');
    await container.start();
    log.info('Worker container started — waiting for it to exit');

    const startTime = Date.now();
    const { StatusCode } = await container.wait();
    const durationMs = Date.now() - startTime;
    log.info(
      { exitCode: StatusCode, durationMs, durationMin: Math.round(durationMs / 60_000) },
      'Worker container exited',
    );

    log.info('Collecting container logs');
    const logStream = await container.logs({ stdout: true, stderr: true, follow: false });
    const logs = logStream.toString('utf8');
    log.info({ logBytes: logs.length }, 'Collected container logs');

    // Remove container but leave volume for potential follow-ups
    await container.remove({ force: true });
    log.info('Removed finished container (volume preserved for follow-ups)');

    return { exitCode: StatusCode, logs };
  }

  async destroyTask(cardShortLink: string): Promise<void> {
    const name = this.containerName(cardShortLink);
    const vol = this.volumeName(cardShortLink);
    const log = logger.child({ phase: 'cleanup', backend: 'docker', container: name });

    log.info({ volume: vol }, 'Starting container and volume destruction');

    try {
      const container = this.docker.getContainer(name);
      const info = await container.inspect();
      if (info.State.Running) {
        log.info('Container is still running — stopping it');
        await container.stop({ t: 10 });
        log.info('Container stopped');
      }
      await container.remove({ force: true });
      log.info('Container removed');
    } catch {
      log.info('Container already removed or not found — skipping');
    }

    try {
      await this.docker.getVolume(vol).remove();
      log.info({ volume: vol }, 'Volume removed');
    } catch {
      log.warn({ volume: vol }, 'Volume already removed or not found');
    }

    log.info('Destroy complete');
  }

  async listWorkers(): Promise<WorkerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_KEY}=worker`] },
    });

    return containers.map((c) => ({
      name: c.Names[0]?.replace('/', '') ?? 'unknown',
      card: c.Labels[CARD_LABEL] ?? 'unknown',
      state: c.State,
    }));
  }
}

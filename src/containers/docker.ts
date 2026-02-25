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
    const { cardShortLink, repoUrl, branchName, prompt, isFollowUp, doneListId } = opts;
    const name = this.containerName(cardShortLink);
    const vol = this.volumeName(cardShortLink);
    const log = logger.child({ container: name });

    // Ensure the volume exists
    try {
      await this.docker.getVolume(vol).inspect();
      log.info('Reusing existing volume');
    } catch {
      await this.docker.createVolume({ Name: vol });
      log.info('Created new volume');
    }

    // Remove any previous container with the same name
    try {
      const old = this.docker.getContainer(name);
      const info = await old.inspect();
      if (info.State.Running) {
        await old.stop({ t: 10 });
      }
      await old.remove({ force: true });
      log.info('Removed previous container');
    } catch {
      // No existing container — that's fine
    }

    if (!isFollowUp) {
      await this.cloneRepoIntoVolume(vol, repoUrl, branchName, log);
    } else {
      await this.fetchBranchInVolume(vol, branchName, log);
    }

    const container = await this.docker.createContainer({
      name,
      Image: config.containers.workerImage,
      Env: [
        `CLAUDE_PROMPT=${prompt}`,
        `ANTHROPIC_API_KEY=${config.anthropic.apiKey ?? ''}`,
        `GITHUB_TOKEN=${config.github.token ?? ''}`,
        `TRELLO_API_KEY=${config.trello.apiKey ?? ''}`,
        `TRELLO_TOKEN=${config.trello.token ?? ''}`,
        `TRELLO_DONE_LIST_ID=${doneListId ?? ''}`,
        'CI=1',
        'TERM=dumb',
      ],
      HostConfig: {
        Binds: [`${vol}:/workspace`],
        Memory: 4 * 1024 * 1024 * 1024, // 4 GB
        ShmSize: 256 * 1024 * 1024,      // 256 MB
      },
      Labels: {
        [LABEL_KEY]: 'worker',
        [CARD_LABEL]: cardShortLink,
      },
    });

    log.info('Starting worker container');
    await container.start();

    const { StatusCode } = await container.wait();
    log.info({ exitCode: StatusCode }, 'Worker container exited');

    const logStream = await container.logs({ stdout: true, stderr: true, follow: false });
    const logs = logStream.toString('utf8');

    // Remove container but leave volume for potential follow-ups
    await container.remove({ force: true });

    return { exitCode: StatusCode, logs };
  }

  private async cloneRepoIntoVolume(
    vol: string,
    repoUrl: string,
    branchName: string,
    log: typeof logger,
  ): Promise<void> {
    const authedUrl = repoUrl.replace('https://', `https://oauth2:${config.github.token ?? ''}@`);

    const container = await this.docker.createContainer({
      Image: 'alpine/git:latest',
      Cmd: [
        'sh', '-c',
        `git clone --depth 50 ${authedUrl} /workspace && cd /workspace && git checkout -b ${branchName}`,
      ],
      HostConfig: { Binds: [`${vol}:/workspace`] },
    });

    await container.start();
    const { StatusCode } = await container.wait();

    const logStream = await container.logs({ stdout: true, stderr: true });
    const output = logStream.toString('utf8');
    await container.remove({ force: true });

    if (StatusCode !== 0) {
      throw new Error(`Failed to clone repo (exit ${StatusCode}): ${output}`);
    }

    log.info({ repoUrl, branchName }, 'Repo cloned into volume');
  }

  private async fetchBranchInVolume(
    vol: string,
    branchName: string,
    log: typeof logger,
  ): Promise<void> {
    const container = await this.docker.createContainer({
      Image: 'alpine/git:latest',
      Cmd: [
        'sh', '-c',
        `cd /workspace && git fetch origin && git checkout ${branchName} && git pull origin ${branchName} || true`,
      ],
      HostConfig: { Binds: [`${vol}:/workspace`] },
    });

    await container.start();
    const { StatusCode } = await container.wait();
    await container.remove({ force: true });

    if (StatusCode !== 0) {
      log.warn({ branchName }, 'fetch/checkout had non-zero exit — may be first push');
    }

    log.info({ branchName }, 'Branch checked out in volume');
  }

  async destroyTask(cardShortLink: string): Promise<void> {
    const name = this.containerName(cardShortLink);
    const vol = this.volumeName(cardShortLink);
    const log = logger.child({ container: name });

    try {
      const container = this.docker.getContainer(name);
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop({ t: 10 });
      }
      await container.remove({ force: true });
      log.info('Container removed');
    } catch {
      // Already gone
    }

    try {
      await this.docker.getVolume(vol).remove();
      log.info('Volume removed');
    } catch {
      log.warn('Volume already removed or not found');
    }
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

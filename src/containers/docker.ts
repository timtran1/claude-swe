import { Writable } from 'node:stream';
import Docker from 'dockerode';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ContainerBackend, RunTaskOptions, WorkerInfo } from './backend.js';

const CONTAINER_PREFIX = 'claude-swe-';
const LABEL_KEY = 'claude-swe';
const CARD_LABEL = 'claude-swe.card';

/**
 * Creates a minimal POSIX tar archive containing a single file.
 * Used to inject the feedback prompt into a stopped container via putArchive.
 */
function createSingleFileTar(filePath: string, content: string): Buffer {
  const BLOCK = 512;
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(BLOCK, 0);

  // Name (100 bytes, null-terminated)
  header.write(filePath.slice(0, 99), 0, 'ascii');
  // Mode: 0644
  header.write('0000644\0', 100, 'ascii');
  // UID / GID
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  // File size in octal (11 digits + null)
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  // Mtime in octal
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  // Type flag: '0' = regular file
  header[156] = 0x30;
  // Magic + version
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');

  // Checksum: treat checksum field as 8 spaces, sum all bytes
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < BLOCK; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

  // Data padded to BLOCK boundary + two zero end-of-archive blocks
  const paddedData = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
  data.copy(paddedData);

  return Buffer.concat([header, paddedData, Buffer.alloc(BLOCK * 2, 0)]);
}

export class DockerBackend implements ContainerBackend {
  private docker = new Docker({ socketPath: '/var/run/docker.sock' });

  private containerName(cardShortLink: string): string {
    return `${CONTAINER_PREFIX}${cardShortLink}`;
  }

  private volumeName(cardShortLink: string): string {
    return `${CONTAINER_PREFIX}vol-${cardShortLink}`;
  }

  async runTask(opts: RunTaskOptions): Promise<{ exitCode: number; logs: string }> {
    const { cardShortLink, cardId, prompt, planPrompt, executePrompt, planModel, executeModel, doneListId, isFollowUp } = opts;
    const name = this.containerName(cardShortLink);
    const vol = this.volumeName(cardShortLink);
    const log = logger.child({ phase: 'container', backend: 'docker', container: name });

    // --- Feedback fast-path: reuse the existing stopped container ---
    if (isFollowUp) {
      try {
        const container = this.docker.getContainer(name);
        const info = await container.inspect();

        // If still running (previous task hasn't finished), wait for it first
        if (info.State.Running) {
          log.info('Feedback: previous container still running — waiting for it to stop');
          await container.wait();
        }

        log.info('Feedback: writing prompt file into stopped container via putArchive');
        const tar = createSingleFileTar('workspace/.feedback-prompt', prompt ?? '');
        await container.putArchive(tar, { path: '/' });

        log.info('Feedback: starting stopped container');
        await container.start();

        const startTime = Date.now();
        const { StatusCode } = await container.wait();
        const durationMs = Date.now() - startTime;
        log.info(
          { exitCode: StatusCode, durationMs, durationMin: Math.round(durationMs / 60_000) },
          'Feedback container finished — preserved for next round',
        );

        const logStream = await container.logs({ stdout: true, stderr: true, follow: false });
        const logs = logStream.toString('utf8');
        log.info({ logBytes: logs.length }, 'Collected feedback container logs');

        return { exitCode: StatusCode, logs };
      } catch (err) {
        log.warn({ err }, 'Feedback: could not reuse existing container — falling back to fresh container');
        // Fall through to the new-container path below
      }
    }

    // --- New container path (new task, or fallback if container is gone) ---

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
    const isTwoPhase = !!(planPrompt && executePrompt);
    log.info(
      {
        image,
        memoryMb,
        shmMb,
        volume: vol,
        mode: isTwoPhase ? 'two-phase' : 'single-phase',
        envVars: isTwoPhase
          ? ['CLAUDE_PLAN_PROMPT', 'CLAUDE_EXECUTE_PROMPT', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN', 'CARD_ID', 'TRELLO_DONE_LIST_ID', 'CI', 'TERM']
          : ['CLAUDE_PROMPT', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN', 'CARD_ID', 'TRELLO_DONE_LIST_ID', 'CI', 'TERM'],
      },
      'Creating worker container',
    );

    const container = await this.docker.createContainer({
      name,
      Image: image,
      Env: [
        ...(isTwoPhase
          ? [`CLAUDE_PLAN_PROMPT=${planPrompt}`, `CLAUDE_EXECUTE_PROMPT=${executePrompt}`]
          : [`CLAUDE_PROMPT=${prompt ?? ''}`]),
        `ANTHROPIC_API_KEY=${config.anthropic.apiKey ?? ''}`,
        `GITHUB_TOKEN=${config.github.token ?? ''}`,
        `TRELLO_API_KEY=${config.trello.apiKey ?? ''}`,
        `TRELLO_TOKEN=${config.trello.token ?? ''}`,
        `CARD_ID=${cardId}`,
        `TRELLO_DONE_LIST_ID=${doneListId ?? ''}`,
        `CLAUDE_PLAN_MODEL=${planModel ?? 'opus'}`,
        `CLAUDE_EXECUTE_MODEL=${executeModel ?? 'sonnet'}`,
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

    // Container stays stopped — preserved for feedback loop, destroyed on PR close
    log.info('Task complete — container preserved for feedback loop (destroyed on PR close)');

    return { exitCode: StatusCode, logs };
  }

  async streamLogs(cardShortLink: string, onLine: (line: string) => void, onDone: () => void): Promise<void> {
    const name = this.containerName(cardShortLink);
    return new Promise((resolve) => {
      let container: Docker.Container;
      try {
        container = this.docker.getContainer(name);
      } catch {
        onDone();
        resolve();
        return;
      }

      container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
        if (err || !stream) {
          onDone();
          resolve();
          return;
        }

        let buffer = '';
        const handleChunk = (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line) onLine(line);
          }
        };

        const out = new Writable({ write(chunk, _, cb) { handleChunk(chunk); cb(); } });
        const err2 = new Writable({ write(chunk, _, cb) { handleChunk(chunk); cb(); } });

        out.on('finish', () => { onDone(); resolve(); });
        out.on('error', () => { onDone(); resolve(); });

        container.modem.demuxStream(stream, out, err2);
      });
    });
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

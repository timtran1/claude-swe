import Docker from 'dockerode';
import { config } from '../config.js';
import { logger } from '../logger.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const WORKER_IMAGE = config.WORKER_IMAGE;
const CONTAINER_PREFIX = 'claude-swe-';

// Naming: claude-swe-<cardShortLink>
function containerName(cardShortLink: string): string {
  return `${CONTAINER_PREFIX}${cardShortLink}`;
}

function volumeName(cardShortLink: string): string {
  return `${CONTAINER_PREFIX}vol-${cardShortLink}`;
}

interface RunTaskOptions {
  cardShortLink: string;
  repoUrl: string;
  branchName: string;
  prompt: string;
  /** If true, re-use existing container's volume (for feedback on existing PR) */
  isFollowUp: boolean;
}

/**
 * Spin up a worker container for a task.
 *
 * - Creates a persistent Docker volume for the workspace
 * - For new tasks: clones repo into the volume via git clone
 * - For follow-ups: re-uses the existing volume (repo already there)
 * - Runs Claude Code with the prompt
 * - Returns when Claude finishes (container exits)
 */
export async function runTaskInContainer(opts: RunTaskOptions): Promise<{ exitCode: number; logs: string }> {
  const { cardShortLink, repoUrl, branchName, prompt, isFollowUp } = opts;
  const name = containerName(cardShortLink);
  const vol = volumeName(cardShortLink);
  const log = logger.child({ container: name });

  // Ensure the volume exists
  try {
    await docker.getVolume(vol).inspect();
    log.info('Reusing existing volume');
  } catch {
    await docker.createVolume({ Name: vol });
    log.info('Created new volume');
  }

  // Remove any previous container with the same name (from a past run)
  try {
    const old = docker.getContainer(name);
    const info = await old.inspect();
    if (info.State.Running) {
      await old.stop({ t: 10 });
    }
    await old.remove({ force: true });
    log.info('Removed previous container');
  } catch {
    // No existing container — that's fine
  }

  // For new tasks, clone the repo into the volume first using a lightweight init container
  if (!isFollowUp) {
    await cloneRepoIntoVolume(vol, repoUrl, branchName, log);
  } else {
    // For follow-ups, fetch latest and checkout the branch
    await fetchBranchInVolume(vol, branchName, log);
  }

  // Create and start the worker container
  const container = await docker.createContainer({
    name,
    Image: WORKER_IMAGE,
    Env: [
      `CLAUDE_PROMPT=${prompt}`,
      `ANTHROPIC_API_KEY=${config.ANTHROPIC_API_KEY}`,
      `GITHUB_TOKEN=${config.GITHUB_TOKEN}`,
      `TRELLO_API_KEY=${config.TRELLO_API_KEY}`,
      `TRELLO_TOKEN=${config.TRELLO_TOKEN}`,
      `TRELLO_DONE_LIST_ID=${config.TRELLO_DONE_LIST_ID}`,
      'CI=1',
      'TERM=dumb',
    ],
    HostConfig: {
      Binds: [`${vol}:/workspace`],
      // Memory limit per worker — prevent runaway processes
      Memory: 4 * 1024 * 1024 * 1024, // 4 GB
      // SHM size for Chromium
      ShmSize: 256 * 1024 * 1024, // 256 MB
    },
    Labels: {
      'claude-swe': 'worker',
      'claude-swe.card': cardShortLink,
    },
  });

  log.info('Starting worker container');
  await container.start();

  // Wait for the container to finish
  const { StatusCode } = await container.wait();
  log.info({ exitCode: StatusCode }, 'Worker container exited');

  // Collect logs
  const logStream = await container.logs({ stdout: true, stderr: true, follow: false });
  const logs = logStream.toString('utf8');

  // Clean up the container (but NOT the volume — that persists for feedback)
  await container.remove({ force: true });

  return { exitCode: StatusCode, logs };
}

/**
 * Clone a repo into a Docker volume using a disposable container.
 */
async function cloneRepoIntoVolume(
  vol: string,
  repoUrl: string,
  branchName: string,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const authedUrl = repoUrl.replace('https://', `https://oauth2:${config.GITHUB_TOKEN}@`);

  const container = await docker.createContainer({
    Image: 'alpine/git:latest',
    Cmd: ['sh', '-c', `
      git clone --depth 50 ${authedUrl} /workspace && \
      cd /workspace && \
      git checkout -b ${branchName}
    `],
    HostConfig: {
      Binds: [`${vol}:/workspace`],
    },
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

/**
 * Fetch latest changes and checkout a branch in an existing volume.
 */
async function fetchBranchInVolume(
  vol: string,
  branchName: string,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const container = await docker.createContainer({
    Image: 'alpine/git:latest',
    Cmd: ['sh', '-c', `
      cd /workspace && \
      git fetch origin && \
      git checkout ${branchName} && \
      git pull origin ${branchName} || true
    `],
    HostConfig: {
      Binds: [`${vol}:/workspace`],
    },
  });

  await container.start();
  const { StatusCode } = await container.wait();
  await container.remove({ force: true });

  if (StatusCode !== 0) {
    log.warn({ branchName }, 'fetch/checkout had non-zero exit — may be first push');
  }

  log.info({ branchName }, 'Branch checked out in volume');
}

/**
 * Destroy the container and volume for a card (called when PR is merged/closed).
 */
export async function destroyTaskContainer(cardShortLink: string): Promise<void> {
  const name = containerName(cardShortLink);
  const vol = volumeName(cardShortLink);
  const log = logger.child({ container: name });

  // Stop and remove container if running
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    if (info.State.Running) {
      await container.stop({ t: 10 });
    }
    await container.remove({ force: true });
    log.info('Container removed');
  } catch {
    // Already gone
  }

  // Remove the volume
  try {
    await docker.getVolume(vol).remove();
    log.info('Volume removed');
  } catch {
    log.warn('Volume already removed or not found');
  }
}

/**
 * List all active claude-swe worker containers.
 */
export async function listWorkerContainers(): Promise<
  Array<{ name: string; card: string; state: string }>
> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['claude-swe=worker'] },
  });

  return containers.map((c) => ({
    name: c.Names[0]?.replace('/', '') ?? 'unknown',
    card: c.Labels['claude-swe.card'] ?? 'unknown',
    state: c.State,
  }));
}

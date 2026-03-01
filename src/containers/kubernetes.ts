/**
 * Kubernetes container backend.
 *
 * Each task gets:
 *   - A PersistentVolumeClaim (workspace storage, survives between task + feedback runs)
 *   - A Job with an init container (git clone/fetch) and a worker container (Claude Code)
 *
 * Required RBAC for the orchestrator's ServiceAccount:
 *   - jobs: create, get, delete (batch/v1, in the configured namespace)
 *   - pods: get, list (v1, same namespace) — to read exit code and logs
 *   - pods/log: get (v1, same namespace)
 *   - persistentvolumeclaims: create, get, delete (v1, same namespace)
 */
import { PassThrough } from 'node:stream';
import * as k8s from '@kubernetes/client-node';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ContainerBackend, RunTaskOptions, WorkerInfo } from './backend.js';

const PREFIX = 'claude-swe-';
const LABEL_KEY = 'claude-swe';
const CARD_LABEL = 'claude-swe.card';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class KubernetesBackend implements ContainerBackend {
  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private batchApi: k8s.BatchV1Api;
  private namespace: string;

  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault(); // ~/.kube/config locally, service account token in-cluster
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    this.namespace = config.containers.kubernetes.namespace;
  }

  private jobName(cardShortLink: string): string {
    return `${PREFIX}${cardShortLink.toLowerCase()}`;
  }

  private pvcName(cardShortLink: string): string {
    return `${PREFIX}vol-${cardShortLink.toLowerCase()}`;
  }

  async runTask(opts: RunTaskOptions): Promise<{ exitCode: number; logs: string }> {
    const { cardShortLink, cardId, prompt, planPrompt, executePrompt, planModel, executeModel, doneListId, isFollowUp } = opts;
    const jobName = this.jobName(cardShortLink);
    const pvcName = this.pvcName(cardShortLink);
    const log = logger.child({ phase: 'container', backend: 'k8s', job: jobName, namespace: this.namespace });

    log.info({ pvcName }, 'Ensuring PVC exists');
    await this.ensurePvc(pvcName, log);

    // Remove any existing job with this name (from a previous run)
    try {
      await this.batchApi.deleteNamespacedJob(
        jobName, this.namespace,
        undefined, undefined, 0, undefined, 'Background',
      );
      // Give the API a moment to process the deletion before re-creating
      await sleep(2000);
      log.info('Deleted previous job');
    } catch {
      log.info('No previous job to delete');
    }

    const isTwoPhase = !!(planPrompt && executePrompt);

    // For feedback runs: inject the prompt via an init container that writes
    // .feedback-prompt to the PVC. The worker entrypoint detects this file and
    // skips setup, running claude directly. Base64-encode to avoid shell escaping.
    const initContainers: k8s.V1Container[] = isFollowUp ? [
      {
        name: 'write-prompt',
        image: 'busybox',
        command: ['sh', '-c', 'printf "%s" "$PROMPT_B64" | base64 -d > /workspace/.feedback-prompt'],
        env: [
          { name: 'PROMPT_B64', value: Buffer.from(prompt ?? '').toString('base64') },
        ],
        volumeMounts: [
          { name: 'workspace', mountPath: '/workspace' },
        ],
      },
    ] : [];

    if (isFollowUp) {
      log.info('Feedback run — init container will write prompt to PVC, worker will skip setup');
    }

    const job: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: { [LABEL_KEY]: 'worker', [CARD_LABEL]: cardShortLink },
      },
      spec: {
        backoffLimit: 0,           // no retries — Claude exiting non-zero is intentional signal
        ttlSecondsAfterFinished: 86400, // 24h safety net; cleanup job deletes it on PR close
        template: {
          metadata: {
            labels: { [LABEL_KEY]: 'worker', [CARD_LABEL]: cardShortLink },
          },
          spec: {
            restartPolicy: 'Never',
            ...(initContainers.length > 0 ? { initContainers } : {}),
            containers: [
              {
                name: 'worker',
                image: config.containers.workerImage,
                imagePullPolicy: 'Always',
                env: [
                  ...(isTwoPhase
                    ? [
                        { name: 'CLAUDE_PLAN_PROMPT',    value: planPrompt },
                        { name: 'CLAUDE_EXECUTE_PROMPT', value: executePrompt },
                      ]
                    : [
                        { name: 'CLAUDE_PROMPT', value: prompt ?? '' },
                      ]),
                  { name: 'ANTHROPIC_API_KEY',     value: config.anthropic.apiKey ?? '' },
                  { name: 'GITHUB_TOKEN',          value: config.github.token ?? '' },
                  { name: 'TRELLO_API_KEY',        value: config.trello.apiKey ?? '' },
                  { name: 'TRELLO_TOKEN',          value: config.trello.token ?? '' },
                  { name: 'CARD_ID',               value: cardId },
                  { name: 'TRELLO_DONE_LIST_ID',   value: doneListId ?? '' },
                  { name: 'CLAUDE_PLAN_MODEL',     value: planModel ?? 'opus' },
                  { name: 'CLAUDE_EXECUTE_MODEL',  value: executeModel ?? 'sonnet' },
                  { name: 'CI',                    value: '1' },
                  { name: 'TERM',                  value: 'dumb' },
                ],
                resources: {
                  requests: { memory: '512Mi', cpu: '500m' },
                  limits:   { memory: '4Gi' },
                },
                volumeMounts: [
                  { name: 'workspace', mountPath: '/workspace' },
                  { name: 'dshm',      mountPath: '/dev/shm' },
                ],
              },
            ],
            volumes: [
              {
                name: 'workspace',
                persistentVolumeClaim: { claimName: pvcName },
              },
              {
                // Chromium needs a writable /dev/shm larger than the default 64MB
                name: 'dshm',
                emptyDir: { medium: 'Memory', sizeLimit: '256Mi' },
              },
            ],
          },
        },
      },
    };

    log.info(
      {
        image: config.containers.workerImage,
        memoryRequest: '512Mi',
        memoryLimit: '4Gi',
        cpuRequest: '500m',
        pvcName,
        mode: isTwoPhase ? 'two-phase' : 'single-phase',
        envVars: isTwoPhase
          ? ['CLAUDE_PLAN_PROMPT', 'CLAUDE_EXECUTE_PROMPT', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN', 'CARD_ID', 'TRELLO_DONE_LIST_ID', 'CI', 'TERM']
          : ['CLAUDE_PROMPT', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN', 'CARD_ID', 'TRELLO_DONE_LIST_ID', 'CI', 'TERM'],
      },
      'Creating K8s job',
    );
    await this.batchApi.createNamespacedJob(this.namespace, job);
    log.info('K8s job created — entering wait loop');

    return this.waitForJob(jobName, log);
  }

  private async ensurePvc(
    pvcName: string,
    log: typeof logger,
  ): Promise<void> {
    try {
      await this.coreApi.readNamespacedPersistentVolumeClaim(pvcName, this.namespace);
      log.info('Reusing existing PVC');
    } catch {
      const pvc: k8s.V1PersistentVolumeClaim = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: pvcName, namespace: this.namespace },
        spec: {
          accessModes: ['ReadWriteOnce'],
          // Omitting storageClassName uses the cluster's default StorageClass.
          // Set K8S_STORAGE_CLASS to override (e.g. "standard", "gp2").
          ...(config.containers.kubernetes.storageClass ? { storageClassName: config.containers.kubernetes.storageClass } : {}),
          resources: { requests: { storage: '10Gi' } },
        },
      };
      await this.coreApi.createNamespacedPersistentVolumeClaim(this.namespace, pvc);
      log.info('Created PVC');
    }
  }

  private async waitForJob(
    jobName: string,
    log: typeof logger,
  ): Promise<{ exitCode: number; logs: string }> {
    // Poll until the Job reports Complete or Failed
    const startTime = Date.now();
    let pollCount = 0;

    while (true) {
      await sleep(5000);
      pollCount++;

      const { body: job } = await this.batchApi.readNamespacedJob(jobName, this.namespace);
      const conditions = job.status?.conditions ?? [];

      const succeeded = conditions.some((c) => c.type === 'Complete' && c.status === 'True');
      const failed    = conditions.some((c) => c.type === 'Failed'   && c.status === 'True');

      if (!succeeded && !failed) {
        // Log every 12th poll (~60s) to avoid spam
        if (pollCount % 12 === 0) {
          const elapsedMin = Math.round((Date.now() - startTime) / 60_000);
          log.info({ elapsedMin, pollCount }, 'Still waiting for K8s job to complete');
        }
        continue;
      }

      const durationMs = Date.now() - startTime;
      log.info(
        { succeeded, failed, durationMs, durationMin: Math.round(durationMs / 60_000) },
        'K8s job finished',
      );

      // Find the pod created by this job to get exit code + logs
      log.info('Looking up pod for log retrieval');
      const { body: podList } = await this.coreApi.listNamespacedPod(
        this.namespace,
        undefined, undefined, undefined, undefined,
        `job-name=${jobName}`,
      );

      const pod = podList.items[0];
      const exitCode =
        pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode
        ?? (failed ? 1 : 0);

      log.info({ podName: pod?.metadata?.name, exitCode }, 'Found pod');

      let logs = '';
      if (pod?.metadata?.name) {
        try {
          log.info({ podName: pod.metadata.name }, 'Retrieving pod logs');
          const { body } = await this.coreApi.readNamespacedPodLog(
            pod.metadata.name, this.namespace, 'worker',
          );
          logs = body;
          log.info({ logBytes: logs.length }, 'Retrieved pod logs');
        } catch (err) {
          log.warn({ err }, 'Could not retrieve pod logs');
        }
      }

      return { exitCode, logs };
    }
  }

  async streamLogs(cardShortLink: string, onLine: (line: string) => void, onDone: () => void): Promise<void> {
    const jobName = this.jobName(cardShortLink);

    // Find the pod for this job (poll briefly if not yet available)
    let podName: string | undefined;
    for (let i = 0; i < 12; i++) {
      try {
        const { body: podList } = await this.coreApi.listNamespacedPod(
          this.namespace,
          undefined, undefined, undefined, undefined,
          `job-name=${jobName}`,
        );
        const pod = podList.items[0];
        if (pod?.metadata?.name && pod.status?.phase !== 'Pending') {
          podName = pod.metadata.name;
          break;
        }
      } catch { /* ignore */ }
      await sleep(5000);
    }

    if (!podName) {
      onDone();
      return;
    }

    const k8sLog = new k8s.Log(this.kc);
    const stream = new PassThrough();

    return new Promise((resolve) => {
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line) onLine(line);
        }
      });
      stream.on('end', () => {
        if (buffer) onLine(buffer);
        onDone();
        resolve();
      });
      stream.on('error', () => { onDone(); resolve(); });

      k8sLog.log(this.namespace, podName!, 'worker', stream, { follow: true, timestamps: false })
        .catch(() => { onDone(); resolve(); });
    });
  }

  async destroyTask(cardShortLink: string): Promise<void> {
    const jobName = this.jobName(cardShortLink);
    const pvcName = this.pvcName(cardShortLink);
    const log = logger.child({ phase: 'cleanup', backend: 'k8s', job: jobName, namespace: this.namespace });

    log.info({ pvcName }, 'Starting K8s job and PVC destruction');

    try {
      await this.batchApi.deleteNamespacedJob(
        jobName, this.namespace,
        undefined, undefined, 0, undefined, 'Background',
      );
      log.info('Job deleted');
    } catch {
      log.info('Job not found or already deleted — skipping');
    }

    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim(pvcName, this.namespace);
      log.info({ pvcName }, 'PVC deleted');
    } catch {
      log.info({ pvcName }, 'PVC not found or already deleted — skipping');
    }

    log.info('K8s destroy complete');
  }

  async listWorkers(): Promise<WorkerInfo[]> {
    const { body: podList } = await this.coreApi.listNamespacedPod(
      this.namespace,
      undefined, undefined, undefined, undefined,
      `${LABEL_KEY}=worker`,
    );

    return podList.items.map((pod) => ({
      name:  pod.metadata?.name  ?? 'unknown',
      card:  pod.metadata?.labels?.[CARD_LABEL] ?? 'unknown',
      state: pod.status?.phase   ?? 'unknown',
    }));
  }
}

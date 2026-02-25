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
  private coreApi: k8s.CoreV1Api;
  private batchApi: k8s.BatchV1Api;
  private namespace: string;

  constructor() {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault(); // ~/.kube/config locally, service account token in-cluster
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.namespace = config.containers.kubernetes.namespace;
  }

  private jobName(cardShortLink: string): string {
    return `${PREFIX}${cardShortLink}`;
  }

  private pvcName(cardShortLink: string): string {
    return `${PREFIX}vol-${cardShortLink}`;
  }

  async runTask(opts: RunTaskOptions): Promise<{ exitCode: number; logs: string }> {
    const { cardShortLink, cardId, prompt, doneListId } = opts;
    const jobName = this.jobName(cardShortLink);
    const pvcName = this.pvcName(cardShortLink);
    const log = logger.child({ job: jobName, namespace: this.namespace });

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
      // No existing job — fine
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
            containers: [
              {
                name: 'worker',
                image: config.containers.workerImage,
                env: [
                  { name: 'CLAUDE_PROMPT',        value: prompt },
                  { name: 'ANTHROPIC_API_KEY',     value: config.anthropic.apiKey ?? '' },
                  { name: 'GITHUB_TOKEN',          value: config.github.token ?? '' },
                  { name: 'TRELLO_API_KEY',        value: config.trello.apiKey ?? '' },
                  { name: 'TRELLO_TOKEN',          value: config.trello.token ?? '' },
                  { name: 'CARD_ID',               value: cardId },
                  { name: 'TRELLO_DONE_LIST_ID',   value: doneListId ?? '' },
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

    await this.batchApi.createNamespacedJob(this.namespace, job);
    log.info('Created K8s job');

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
    while (true) {
      await sleep(5000);

      const { body: job } = await this.batchApi.readNamespacedJob(jobName, this.namespace);
      const conditions = job.status?.conditions ?? [];

      const succeeded = conditions.some((c) => c.type === 'Complete' && c.status === 'True');
      const failed    = conditions.some((c) => c.type === 'Failed'   && c.status === 'True');

      if (!succeeded && !failed) continue;

      log.info({ succeeded, failed }, 'Job finished');

      // Find the pod created by this job to get exit code + logs
      const { body: podList } = await this.coreApi.listNamespacedPod(
        this.namespace,
        undefined, undefined, undefined, undefined,
        `job-name=${jobName}`,
      );

      const pod = podList.items[0];
      const exitCode =
        pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode
        ?? (failed ? 1 : 0);

      let logs = '';
      if (pod?.metadata?.name) {
        try {
          const { body } = await this.coreApi.readNamespacedPodLog(
            pod.metadata.name, this.namespace, 'worker',
          );
          logs = body;
        } catch (err) {
          log.warn({ err }, 'Could not retrieve pod logs');
        }
      }

      return { exitCode, logs };
    }
  }

  async destroyTask(cardShortLink: string): Promise<void> {
    const jobName = this.jobName(cardShortLink);
    const pvcName = this.pvcName(cardShortLink);
    const log = logger.child({ job: jobName, namespace: this.namespace });

    try {
      await this.batchApi.deleteNamespacedJob(
        jobName, this.namespace,
        undefined, undefined, 0, undefined, 'Background',
      );
      log.info('Job deleted');
    } catch {
      log.warn('Job not found or already deleted');
    }

    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim(pvcName, this.namespace);
      log.info('PVC deleted');
    } catch {
      log.warn('PVC not found or already deleted');
    }
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

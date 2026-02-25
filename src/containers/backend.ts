export interface RunTaskOptions {
  cardShortLink: string;
  /** Full Trello card ID, used by the worker container to download card images */
  cardId: string;
  branchName: string;
  prompt: string;
  /** If true, re-use existing workspace (for feedback on existing PR) */
  isFollowUp: boolean;
  /** Done list ID to pass to the worker container, if card should be moved on completion */
  doneListId?: string;
}

export interface WorkerInfo {
  name: string;
  card: string;
  state: string;
}

export interface ContainerBackend {
  runTask(opts: RunTaskOptions): Promise<{ exitCode: number; logs: string }>;
  destroyTask(cardShortLink: string): Promise<void>;
  listWorkers(): Promise<WorkerInfo[]>;
}

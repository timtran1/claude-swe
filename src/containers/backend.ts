export interface RunTaskOptions {
  cardShortLink: string;
  /** Full Trello card ID, used by the worker container to download card images */
  cardId: string;
  branchName: string;
  /** Single-phase prompt (used for feedback jobs) */
  prompt?: string;
  /** Two-phase new-task: planning prompt for Opus */
  planPrompt?: string;
  /** Two-phase new-task: execution prompt for Sonnet */
  executePrompt?: string;
  /** Model to use for the planning phase */
  planModel?: string;
  /** Model to use for the execution (and single-phase) phase */
  executeModel?: string;
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

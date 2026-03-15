export interface TrelloMember {
  id: string;
  username: string;
  fullName: string;
}

export interface TrelloCard {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  idList: string;
  url: string;
  labels?: Array<{ id: string; name: string; color: string }>;
}

export interface TrelloBoard {
  id: string;
  name: string;
}

export interface TrelloList {
  id: string;
  name: string;
}

// Action types we care about
export type TrelloActionType = 'addMemberToCard' | 'removeMemberFromCard' | 'commentCard' | 'updateCard';

export interface TrelloWebhookAction {
  id: string;
  type: TrelloActionType | string;
  date: string;
  memberCreator: TrelloMember;
  data: {
    card?: TrelloCard & { closed?: boolean };
    board?: TrelloBoard;
    list?: TrelloList;
    text?: string; // for commentCard
    member?: TrelloMember; // for addMemberToCard (partial: only id + name, no username)
    idMember?: string; // raw member ID for addMemberToCard
    old?: { closed?: boolean }; // for updateCard — previous field values
  };
}

export interface TrelloWebhookPayload {
  action: TrelloWebhookAction;
  model: TrelloBoard;
}

// Discriminated union tracking which platform originated a task.
// Trello source: cardId is the Trello card ID.
// Slack source: channelId + threadTs identify the thread; trelloCardId is set if a card was linked.
// Jira source: issueId + issueKey identify the Jira issue; projectId links it to a configured project.
export type TaskSource =
  | { type: 'trello'; cardId: string }
  | { type: 'slack'; channelId: string; threadTs: string; trelloCardId?: string }
  | { type: 'jira'; issueId: string; issueKey: string; projectId: string };

/** Derive the task source from a job, defaulting to Trello for backward compat. */
export function getTaskSource(job: { source?: TaskSource; cardId?: string }): TaskSource {
  if (job.source) return job.source;
  return { type: 'trello', cardId: job.cardId! };
}

/** Reference to a Slack file attachment to be downloaded inside the worker container */
export interface SlackFileRef {
  url: string;
  name: string;
}

// Normalized job data passed to the queue
export interface NewTaskJob {
  // Generic task identifier — Trello shortLinks or s-prefixed Slack IDs
  cardShortLink: string;
  cardName: string;
  cardDesc: string;
  cardUrl: string;
  // Trello-specific (undefined for Slack-only tasks)
  cardId?: string;
  boardId?: string;
  doingListId?: string;
  doneListId?: string;
  // Source tracking
  source?: TaskSource;
  // Slack tasks carry their own resolved repos (Trello tasks resolve from boardId at runtime)
  repos?: string[];
  // Slack tasks embed the task description directly
  taskDescription?: string;
  // Slack file attachments to download inside the worker container
  slackFiles?: SlackFileRef[];
  // Jira transition IDs resolved at enqueue time (require issue context — cannot defer to worker)
  jiraDoingTransitionId?: string;
  jiraDoneTransitionId?: string;
}

export interface FeedbackJob {
  cardShortLink: string;
  cardName: string;
  cardUrl: string;
  cardDesc: string;
  commentText: string;
  commenterName: string;
  // Trello-specific
  cardId?: string;
  boardId?: string;
  doingListId?: string;
  doneListId?: string;
  // Source tracking
  source?: TaskSource;
  // Repos for Slack tasks
  repos?: string[];
  // Slack file attachments to download inside the worker container
  slackFiles?: SlackFileRef[];
  // Jira transition IDs resolved at enqueue time
  jiraDoingTransitionId?: string;
  jiraDoneTransitionId?: string;
}

export interface CleanupJob {
  cardShortLink: string;
  prUrl?: string;
  reason: 'merged' | 'closed' | 'archived';
  repoFullName?: string; // e.g. "owner/repo" — the repo whose PR was just closed
  source?: TaskSource;
}

export interface CancelJob {
  cardShortLink: string;
  cardId?: string;
  source?: TaskSource;
}

// GitHub webhook payloads (subset of what we need)
export interface GitHubPRWebhookPayload {
  action: 'opened' | 'closed' | 'merged' | 'synchronize' | string;
  pull_request: {
    number: number;
    html_url: string;
    head: {
      ref: string; // branch name, e.g. "claude/abc123"
    };
    merged: boolean;
    state: string;
  };
  repository: {
    full_name: string;
  };
}

/** A Jira issue as returned by the REST API (subset of fields we use) */
export interface JiraIssue {
  id: string;
  /** Issue key, e.g. "PROJ-123" */
  key: string;
  /** REST API URL for this issue */
  self: string;
  fields: {
    summary: string;
    description: unknown; // ADF (Atlassian Document Format) object
    status: { id: string; name: string };
    assignee: { accountId: string; displayName: string } | null;
    project: { id: string; key: string; name: string };
    attachment?: Array<{ id: string; filename: string; mimeType: string; content: string }>;
  };
}

/** Payload sent by Jira webhooks for issue and comment events */
export interface JiraWebhookPayload {
  /** e.g. "jira:issue_updated", "comment_created" */
  webhookEvent: string;
  /** e.g. "issue_assigned", "issue_comment_edited" */
  issue_event_type_name?: string;
  issue: JiraIssue;
  comment?: {
    id: string;
    body: unknown; // ADF object
    author: { accountId: string; displayName: string };
  };
  user: { accountId: string; displayName: string };
  changelog?: {
    items: Array<{
      field: string;
      fromString: string | null;
      toString: string | null;
      from: string | null;
      to: string | null;
    }>;
  };
}

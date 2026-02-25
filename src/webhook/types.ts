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
  labels: Array<{ id: string; name: string; color: string }>;
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
export type TrelloActionType = 'addMemberToCard' | 'commentCard';

export interface TrelloWebhookAction {
  id: string;
  type: TrelloActionType | string;
  date: string;
  memberCreator: TrelloMember;
  data: {
    card?: TrelloCard;
    board?: TrelloBoard;
    list?: TrelloList;
    text?: string; // for commentCard
    member?: TrelloMember; // for addMemberToCard
  };
}

export interface TrelloWebhookPayload {
  action: TrelloWebhookAction;
  model: TrelloBoard;
}

// Normalized job data passed to the queue
export interface NewTaskJob {
  cardId: string;
  cardShortLink: string;
  cardName: string;
  cardDesc: string;
  cardUrl: string;
  doneListId?: string;
}

export interface FeedbackJob {
  cardId: string;
  cardShortLink: string;
  cardUrl: string;
  cardDesc: string;
  commentText: string;
  commenterName: string;
  doneListId?: string;
}

export interface CleanupJob {
  cardShortLink: string;
  prUrl?: string;
  reason: 'merged' | 'closed';
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

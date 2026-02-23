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
}

export interface FeedbackJob {
  cardId: string;
  cardShortLink: string;
  cardUrl: string;
  commentText: string;
  commenterName: string;
}

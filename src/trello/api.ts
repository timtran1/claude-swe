import { config } from '../config.js';

const BASE = 'https://api.trello.com/1';

function authParams(): string {
  return `key=${config.trello.apiKey ?? ''}&token=${config.trello.token ?? ''}`;
}

async function trelloFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}${authParams()}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`Trello API error ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
}

export async function fetchCardAttachments(cardId: string): Promise<TrelloAttachment[]> {
  return trelloFetch<TrelloAttachment[]>(`/cards/${cardId}/attachments`);
}

export async function postTrelloComment(cardId: string, text: string): Promise<void> {
  await trelloFetch(`/cards/${cardId}/actions/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

export async function moveCardToList(cardId: string, listId: string): Promise<void> {
  await trelloFetch(`/cards/${cardId}?idList=${listId}`, {
    method: 'PUT',
  });
}

export interface TrelloCardFull {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  idList: string;
  url: string;
}

export async function fetchCard(cardId: string): Promise<TrelloCardFull> {
  return trelloFetch<TrelloCardFull>(`/cards/${cardId}?fields=id,shortLink,name,desc,idList,url`);
}

export interface TrelloBoard {
  id: string;
  name: string;
}

export interface TrelloList {
  id: string;
  name: string;
}

export async function fetchCardMembers(cardId: string): Promise<string[]> {
  const members = await trelloFetch<{ id: string }[]>(`/cards/${cardId}/members?fields=id`);
  return members.map((m) => m.id);
}

export async function archiveCard(cardId: string): Promise<void> {
  await trelloFetch(`/cards/${cardId}?closed=true`, { method: 'PUT' });
}

export async function fetchMyBoards(): Promise<TrelloBoard[]> {
  return trelloFetch<TrelloBoard[]>('/members/me/boards?fields=id,name');
}

export async function fetchBoardLists(boardId: string): Promise<TrelloList[]> {
  return trelloFetch<TrelloList[]>(`/boards/${boardId}/lists?fields=id,name`);
}

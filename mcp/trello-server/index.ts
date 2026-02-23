import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.TRELLO_API_KEY;
const TOKEN = process.env.TRELLO_TOKEN;
const DONE_LIST_ID = process.env.TRELLO_DONE_LIST_ID;

if (!API_KEY || !TOKEN) {
  console.error('TRELLO_API_KEY and TRELLO_TOKEN must be set');
  process.exit(1);
}

const BASE = 'https://api.trello.com/1';

function authParams(): string {
  return `key=${API_KEY}&token=${TOKEN}`;
}

async function trelloFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}${authParams()}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Trello API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

const server = new McpServer({
  name: 'trello',
  version: '1.0.0',
});

// Get full card details
server.tool(
  'get_card',
  'Fetch a Trello card including its description, checklists, labels, and attachments',
  { card_id: z.string().describe('The Trello card ID') },
  async ({ card_id }) => {
    const [card, checklists, attachments] = await Promise.all([
      trelloFetch<{
        id: string;
        name: string;
        desc: string;
        url: string;
        idList: string;
        labels: Array<{ name: string; color: string }>;
      }>(`/cards/${card_id}?fields=name,desc,url,idList,labels`),
      trelloFetch<Array<{
        id: string;
        name: string;
        checkItems: Array<{ name: string; state: string }>;
      }>>(`/cards/${card_id}/checklists`),
      trelloFetch<Array<{ id: string; name: string; url: string; mimeType: string }>>(
        `/cards/${card_id}/attachments`,
      ),
    ]);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ...card, checklists, attachments }, null, 2),
        },
      ],
    };
  },
);

// Get all lists on the board (useful for finding the Done list ID)
server.tool(
  'get_board_lists',
  'Get all lists on a Trello board',
  { board_id: z.string().describe('The Trello board ID') },
  async ({ board_id }) => {
    const lists = await trelloFetch<Array<{ id: string; name: string }>>(
      `/boards/${board_id}/lists`,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(lists, null, 2) }],
    };
  },
);

// Move card to a list (used to mark as Done)
server.tool(
  'move_card',
  'Move a Trello card to a different list. Use this to move a card to the Done list when work is complete.',
  {
    card_id: z.string().describe('The Trello card ID'),
    list_id: z
      .string()
      .optional()
      .describe(
        `The list ID to move the card to. Defaults to the configured Done list (${DONE_LIST_ID ?? 'not set'})`,
      ),
  },
  async ({ card_id, list_id }) => {
    const targetList = list_id ?? DONE_LIST_ID;
    if (!targetList) {
      throw new Error('No list_id provided and TRELLO_DONE_LIST_ID is not configured');
    }
    await trelloFetch(`/cards/${card_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idList: targetList }),
    });
    return {
      content: [{ type: 'text', text: `Card ${card_id} moved to list ${targetList}` }],
    };
  },
);

// Post a comment on a card
server.tool(
  'add_comment',
  'Post a comment on a Trello card',
  {
    card_id: z.string().describe('The Trello card ID'),
    text: z.string().describe('The comment text (supports markdown)'),
  },
  async ({ card_id, text }) => {
    const result = await trelloFetch<{ id: string }>(`/cards/${card_id}/actions/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return {
      content: [{ type: 'text', text: `Comment posted: ${result.id}` }],
    };
  },
);

// Get recent comments on a card (useful for feedback loop)
server.tool(
  'get_card_comments',
  'Get recent comments on a Trello card',
  {
    card_id: z.string().describe('The Trello card ID'),
    limit: z.number().min(1).max(50).default(10).describe('Number of comments to fetch'),
  },
  async ({ card_id, limit }) => {
    const actions = await trelloFetch<
      Array<{
        id: string;
        type: string;
        date: string;
        memberCreator: { fullName: string; username: string };
        data: { text: string };
      }>
    >(`/cards/${card_id}/actions?filter=commentCard&limit=${limit}`);

    return {
      content: [{ type: 'text', text: JSON.stringify(actions, null, 2) }],
    };
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

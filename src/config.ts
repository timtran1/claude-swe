import { readFileSync } from 'fs';
import { z } from 'zod';
import { fetchMyBoards, fetchBoardLists } from './trello/api.js';

// Recursively resolve "env.KEY" references in parsed JSON.
// Any string value starting with "env." is replaced with process.env[KEY] ?? null.
function resolveEnvRefs(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('env.')) {
    const key = value.slice(4);
    return process.env[key] ?? null;
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvRefs);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnvRefs(v)]),
    );
  }
  return value;
}

const boardSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  includeLists: z.array(z.string()).default([]),
  doing: z.object({
    listId: z.string().min(1).optional(),
    list: z.string().min(1).optional(),
  }).optional(),
  done: z.object({
    listId: z.string().min(1).optional(),
    list: z.string().min(1).optional(),
  }).optional(),
  repos: z.array(z.string().url()).default([]),
}).refine((b) => b.id || b.name, { message: 'Board must have either id or name' });

const agentSchema = z.object({
  planMode: z.boolean().default(true),
  models: z.object({
    plan: z.string().default('opus'),
    execute: z.string().default('sonnet'),
  }).default({}),
  prompts: z.object({
    plan: z.string().optional(),
    execute: z.string().optional(),
    newTask: z.string().optional(),
    feedback: z.string().optional(),
  }).default({}),
}).default({});

const configSchema = z.object({
  agent: agentSchema,
  trello: z.object({
    apiKey: z.string().nullable(),
    apiSecret: z.string().nullable(),
    token: z.string().nullable(),
    botUsername: z.string().default('claude'),
    boards: z.array(boardSchema).default([]),
  }),
  github: z.object({
    token: z.string().nullable(),
    webhookSecret: z.string().nullable(),
  }),
  anthropic: z.object({
    apiKey: z.string().nullable(),
  }),
  server: z.object({
    port: z.number().default(3000),
    webhookBaseUrl: z.string().default(''),
  }),
  redis: z.object({
    host: z.string().default('redis'),
    port: z.number().default(6379),
  }),
  containers: z.object({
    backend: z.enum(['docker', 'kubernetes']).default('docker'),
    workerImage: z.string().default('claude-swe-worker:latest'),
    concurrency: z.number().int().positive().default(10),
    docker: z.object({
      enableSocketMount: z.boolean().default(true),
    }).default({}),
    kubernetes: z.object({
      namespace: z.string().default('default'),
      storageClass: z.string().default(''),
      enableDinD: z.boolean().default(true),
    }).default({}),
  }).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type BoardConfig = z.infer<typeof boardSchema> & { id: string };

const configPath = process.env.CONFIG_PATH ?? './config.json';

let rawJson: unknown;
try {
  rawJson = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to read config file at ${configPath}:`, err);
  process.exit(1);
}

const resolved = resolveEnvRefs(rawJson);

const parsed = configSchema.safeParse(resolved);
if (!parsed.success) {
  console.error('Invalid config:');
  for (const [field, issues] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${issues?.join(', ')}`);
  }
  process.exit(1);
}

export const config = parsed.data;

export function getBoardConfig(boardId: string): BoardConfig | undefined {
  return config.trello.boards.find((b) => b.id === boardId) as BoardConfig | undefined;
}

// Resolve board/list names to IDs at startup using the Trello API.
// Mutates config.trello.boards in-place.
export async function resolveNames(): Promise<void> {
  const boards = config.trello.boards;
  if (boards.length === 0) return;

  const hasAnyName = boards.some((b) => !b.id || b.includeLists.some((l) => !isId(l)) || b.doing?.list || b.done?.list);
  if (!hasAnyName) return;

  let allBoards: { id: string; name: string }[];
  try {
    allBoards = await fetchMyBoards();
  } catch (err) {
    throw new Error(`Failed to fetch Trello boards for name resolution: ${err}`);
  }

  for (const board of boards) {
    // Resolve board name → ID
    if (!board.id) {
      const match = allBoards.find((b) => b.name === board.name);
      if (!match) {
        throw new Error(`Trello board not found by name: "${board.name}"`);
      }
      board.id = match.id;
    }

    const needsListResolution =
      board.includeLists.some((l) => !isId(l)) ||
      (board.doing?.list && !board.doing.listId) ||
      (board.done?.list && !board.done.listId);

    if (!needsListResolution) continue;

    let lists: { id: string; name: string }[];
    try {
      lists = await fetchBoardLists(board.id);
    } catch (err) {
      throw new Error(`Failed to fetch lists for board "${board.name ?? board.id}": ${err}`);
    }

    // Resolve includeLists names → IDs
    board.includeLists = board.includeLists.map((entry) => {
      if (isId(entry)) return entry;
      const match = lists.find((l) => l.name === entry);
      if (!match) {
        throw new Error(`List not found by name "${entry}" on board "${board.name ?? board.id}"`);
      }
      return match.id;
    });

    // Resolve doing.list name → doing.listId
    if (board.doing?.list && !board.doing.listId) {
      const match = lists.find((l) => l.name === board.doing!.list);
      if (!match) {
        throw new Error(`Doing list not found by name "${board.doing.list}" on board "${board.name ?? board.id}"`);
      }
      board.doing.listId = match.id;
    }

    // Resolve done.list name → done.listId
    if (board.done?.list && !board.done.listId) {
      const match = lists.find((l) => l.name === board.done!.list);
      if (!match) {
        throw new Error(`Done list not found by name "${board.done.list}" on board "${board.name ?? board.id}"`);
      }
      board.done.listId = match.id;
    }
  }
}

// Trello IDs are 24-character hex strings. Use this to distinguish IDs from names.
function isId(value: string): boolean {
  return /^[0-9a-f]{24}$/.test(value);
}

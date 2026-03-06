import { readFileSync } from 'fs';
import { z } from 'zod';
import { fetchMyBoards, fetchBoardLists } from './trello/api.js';
import { logger } from './logger.js';

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
    guard: z.string().default('haiku'),
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

// Deep copy of original boards before any resolution — used to retry failed resolutions.
const originalBoards = JSON.parse(JSON.stringify(config.trello.boards)) as typeof config.trello.boards;

export function getBoardConfig(boardId: string): BoardConfig | undefined {
  return config.trello.boards.find((b) => b.id === boardId) as BoardConfig | undefined;
}

// Retry name resolution for any boards/lists that still have names but no IDs.
// Safe to call on every webhook — exits immediately if everything is already resolved.
export async function ensureNamesResolved(): Promise<void> {
  const needsRetry = originalBoards.some((orig) => {
    const current = config.trello.boards.find((b) => b.name === orig.name || b.id === orig.id);
    return !current || !current.id;
  });
  if (!needsRetry) return;
  // Reset to original config and re-run full resolution
  config.trello.boards.splice(0, config.trello.boards.length, ...JSON.parse(JSON.stringify(originalBoards)));
  await resolveNames();
}

// Resolve board/list names to IDs at startup using the Trello API.
// Mutates config.trello.boards in-place. Logs errors and skips bad boards instead of throwing.
export async function resolveNames(): Promise<void> {
  const boards = config.trello.boards;
  if (boards.length === 0) return;

  const hasAnyName = boards.some((b) => !b.id || b.includeLists.some((l) => !isId(l)) || b.doing?.list || b.done?.list);
  if (!hasAnyName) return;

  let allBoards: { id: string; name: string }[];
  try {
    allBoards = await fetchMyBoards();
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Trello boards for name resolution — board name resolution skipped');
    return;
  }

  const toRemove: number[] = [];

  for (let i = 0; i < boards.length; i++) {
    const board = boards[i];

    // Resolve board name → ID
    if (!board.id) {
      const match = allBoards.find((b) => b.name === board.name);
      if (!match) {
        logger.error(
          { boardName: board.name },
          `Trello board "${board.name}" not found — make sure the Claude bot user has been added as a member of the board`,
        );
        toRemove.push(i);
        continue;
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
      logger.error({ err, boardName: board.name ?? board.id }, `Failed to fetch lists for board "${board.name ?? board.id}" — skipping board`);
      toRemove.push(i);
      continue;
    }

    // Resolve includeLists names → IDs
    let failed = false;
    const resolvedIncludeLists: string[] = [];
    for (const entry of board.includeLists) {
      if (isId(entry)) { resolvedIncludeLists.push(entry); continue; }
      const match = lists.find((l) => l.name === entry);
      if (!match) {
        logger.error({ boardName: board.name ?? board.id, listName: entry }, `List "${entry}" not found on board "${board.name ?? board.id}" — skipping board`);
        failed = true;
        break;
      }
      resolvedIncludeLists.push(match.id);
    }
    if (failed) { toRemove.push(i); continue; }
    board.includeLists = resolvedIncludeLists;

    // Resolve doing.list name → doing.listId
    if (board.doing?.list && !board.doing.listId) {
      const match = lists.find((l) => l.name === board.doing!.list);
      if (!match) {
        logger.error({ boardName: board.name ?? board.id, listName: board.doing.list }, `Doing list "${board.doing.list}" not found on board "${board.name ?? board.id}" — skipping board`);
        toRemove.push(i);
        continue;
      }
      board.doing.listId = match.id;
    }

    // Resolve done.list name → done.listId
    if (board.done?.list && !board.done.listId) {
      const match = lists.find((l) => l.name === board.done!.list);
      if (!match) {
        logger.error({ boardName: board.name ?? board.id, listName: board.done.list }, `Done list "${board.done.list}" not found on board "${board.name ?? board.id}" — skipping board`);
        toRemove.push(i);
        continue;
      }
      board.done.listId = match.id;
    }
  }

  // Remove boards that failed to resolve (reverse order to preserve indices)
  for (const i of [...toRemove].reverse()) {
    boards.splice(i, 1);
  }
}

// Trello IDs are 24-character hex strings. Use this to distinguish IDs from names.
function isId(value: string): boolean {
  return /^[0-9a-f]{24}$/.test(value);
}

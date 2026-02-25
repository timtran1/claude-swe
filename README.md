# Claude SWE Agent

Autonomous development agent: tag `@claude` on a Trello card → Claude codes it, tests it, opens a PR, and moves the card to Done. When humans comment on the card, Claude reads the feedback and updates the PR.

Each task runs in its own isolated Docker container with persistent storage. The container has `mise` (universal runtime manager) so Claude auto-detects and installs whatever the project needs — Node, Python, Go, Rust, Ruby, etc. When the PR is merged or closed, the container and volume are automatically cleaned up.

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Orchestrator (lightweight Node.js server)       │
│                                                 │
│  Trello webhook ─┬─► Task Queue (BullMQ/Redis)  │
│  GitHub webhook ─┘       │                      │
│                          ▼                      │
│               Container Manager (dockerode)     │
│                 │         │          │           │
│                 ▼         ▼          ▼           │
│          ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│          │Worker #1│ │Worker #2│ │Worker #3│   │
│          │(card A) │ │(card B) │ │(card C) │   │
│          └────┬────┘ └────┬────┘ └────┬────┘   │
│               │           │           │         │
│          vol-A        vol-B       vol-C         │
│         (persist)    (persist)   (persist)      │
└─────────────────────────────────────────────────┘

Each worker container has:
  mise, Claude Code CLI, Playwright + Chromium, gh CLI,
  build-essential, python3, Trello MCP server
```

### Lifecycle

1. **Trello webhook** fires when you tag `@claude` on a card in a watched list
2. **Orchestrator** enqueues a `new-task` job
3. **Worker** clones the repo into a persistent Docker volume, spins up a container
4. **Claude Code** (inside the container) reads the card via Trello MCP, installs deps via `mise`, codes, tests (including Playwright visual tests), opens a PR, moves card to Done
5. **Human comments** on the card → another webhook → orchestrator re-uses the same volume, runs Claude again with the feedback as a follow-up prompt
6. **PR merged/closed** → GitHub webhook → orchestrator destroys the container and volume

## Setup

### 1. Create a Trello bot account

Create a Trello account for Claude (e.g., `claude-bot`) and add it to your board. This is the account that will be assigned to cards to trigger tasks and will post comments.

### 2. Get Trello credentials

**API key**: go to `https://trello.com/power-ups/admin`, create a Power-Up, copy the API key.

**Token**: log in to Trello as the bot account, then visit:
```
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=claude-swe&key=YOUR_API_KEY
```
Approve and copy the token. Comments and card moves will appear as this bot account.

**Board and list IDs**:
- Board ID: open your board in Trello — it's in the URL (`trello.com/b/<BOARD_ID>/...`)
- List IDs: once you have a key and token:
  ```bash
  curl "https://api.trello.com/1/boards/<BOARD_ID>/lists?key=<KEY>&token=<TOKEN>"
  ```

### 3. Configure

```bash
cp config.example.json config.json
cp .env.example .env
```

Edit `config.json` — non-sensitive settings live here:

```json
{
  "trello": {
    "apiKey": "env.TRELLO_API_KEY",
    "token": "env.TRELLO_TOKEN",
    "botUsername": "claude-bot",
    "boards": [
      {
        "id": "YOUR_BOARD_ID",
        "includeLists": ["LIST_ID_TODO", "LIST_ID_IN_PROGRESS"],
        "done": { "listId": "LIST_ID_DONE" }
      }
    ]
  },
  "github": {
    "token": "env.GITHUB_TOKEN",
    "webhookSecret": "env.GITHUB_WEBHOOK_SECRET",
    "defaultRepo": ""
  },
  "anthropic": { "apiKey": "env.ANTHROPIC_API_KEY" },
  "server": { "port": 3000, "webhookBaseUrl": "https://your-server.example.com" },
  "redis": { "host": "redis", "port": 6379 },
  "containers": { "backend": "docker", "workerImage": "claude-swe-worker:latest" }
}
```

- **`includeLists`**: only cards in these lists trigger a task when the bot is assigned. Empty array = react to all lists.
- **`done`**: optional — if set, Claude moves the card to this list when the PR is opened. Omit to skip card movement.
- **`env.KEY`**: any value starting with `env.` is resolved from the environment variable of that name at startup. Missing vars resolve to `null` (graceful degradation, logged on `/health`).

Edit `.env` — secrets only:
```
TRELLO_API_KEY=
TRELLO_TOKEN=
GITHUB_TOKEN=
GITHUB_WEBHOOK_SECRET=
ANTHROPIC_API_KEY=
```

### 4. Build and run

```bash
# Build worker image first (takes a few minutes — installs mise, Claude Code, Playwright, etc.)
docker compose build worker

# Build orchestrator and start everything
docker compose up --build -d
```

The orchestrator will **automatically register Trello webhooks** for each board in your config on startup. You just need the server to be publicly reachable first (use [ngrok](https://ngrok.com) for local dev):
```bash
ngrok http 3000
# Update server.webhookBaseUrl in config.json with the ngrok URL, then restart
```

### 5. GitHub webhook (for PR cleanup)

- Go to your repo → Settings → Webhooks → Add webhook
- Payload URL: `https://your-server.example.com/webhooks/github`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET` in `.env`
  - Generate one: `openssl rand -hex 32`
- Events: select **Pull requests** only

## Using it

1. Create a Trello card with a clear task description
2. Include the target repo in the description:
   ```
   repo: https://github.com/myorg/my-app
   ```
3. For frontend tasks, attach screenshot/mockup images to the card
4. Assign the Claude bot to the card
5. Claude will:
   - Spin up an isolated container
   - Detect the project type and install all dependencies
   - Code the solution, run tests
   - For frontend: take Playwright screenshots and iterate until it matches designs
   - Open a PR, move the card to Done, post the PR link as a comment
6. Comment on the card to give feedback → Claude reads it and updates the PR

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Status + credential check (`trello`, `github`, `anthropic` booleans) |
| `GET` | `/workers` | List active worker containers |
| `HEAD/POST` | `/webhooks/trello` | Trello webhook receiver |
| `POST` | `/webhooks/github` | GitHub webhook (PR closed → cleanup) |

## Project structure

```
Dockerfile              — Orchestrator (slim: webhook server + queue)
Dockerfile.worker       — Worker image (fat: mise, Claude Code, Playwright, gh, build tools)
worker-entrypoint.sh    — Container entrypoint: set up MCP config, run Claude
docker-compose.yml      — Orchestrator + Redis (worker built as image only)
config.example.json     — Config template (copy to config.json)

src/
  index.ts              — Express server, routes, startup webhook registration
  config.ts             — JSON config parser (env.KEY resolution + Zod validation)
  logger.ts             — Pino structured logging
  webhook/
    handler.ts          — Trello + GitHub webhook verification, board/list filtering, routing
    types.ts            — Payload and job types
  queue/
    queue.ts            — BullMQ queue definition
    worker.ts           — Job processor (new-task, feedback, cleanup)
  containers/
    backend.ts          — ContainerBackend interface
    manager.ts          — Backend selection (docker/kubernetes)
    docker.ts           — Docker container lifecycle via dockerode
    kubernetes.ts       — Kubernetes Job/PVC lifecycle
  workspace/
    repo.ts             — Extract repo URL from card description
  trello/
    api.ts              — Thin Trello client for error comments and card moves
  agent/
    prompt.ts           — Build prompts for Claude Code

mcp/
  trello-server/        — MCP server baked into worker image
    index.ts            — Tools: get_card, move_card, add_comment, get_card_comments, get_board_lists
    download-images.ts  — CLI script run at container startup to fetch card images to /workspace/.card-images/
```

## Config reference

**`config.json`** (non-sensitive — commit-safe with `env.KEY` references):

| Field | Description |
|---|---|
| `trello.apiKey` | Trello API key — use `"env.TRELLO_API_KEY"` |
| `trello.token` | Trello OAuth token (bot account) — use `"env.TRELLO_TOKEN"` |
| `trello.botUsername` | Trello username of the bot account |
| `trello.boards[].id` | Board ID to watch |
| `trello.boards[].includeLists` | List IDs that trigger tasks (empty = all lists) |
| `trello.boards[].done.listId` | List ID to move cards to on completion (omit to skip) |
| `github.token` | GitHub PAT (repo + PR permissions) — use `"env.GITHUB_TOKEN"` |
| `github.webhookSecret` | GitHub webhook secret — use `"env.GITHUB_WEBHOOK_SECRET"` |
| `github.defaultRepo` | Fallback repo URL if card doesn't specify one |
| `anthropic.apiKey` | Anthropic API key — use `"env.ANTHROPIC_API_KEY"` |
| `server.port` | HTTP server port (default: `3000`) |
| `server.webhookBaseUrl` | Public URL of this server |
| `redis.host` | Redis host (default: `redis`) |
| `redis.port` | Redis port (default: `6379`) |
| `containers.backend` | `docker` or `kubernetes` (default: `docker`) |
| `containers.workerImage` | Worker Docker image (default: `claude-swe-worker:latest`) |
| `containers.kubernetes.namespace` | K8s namespace (default: `default`) |
| `containers.kubernetes.storageClass` | K8s storage class (default: cluster default) |

**`.env`** (secrets only — never commit):

| Variable | Description |
|---|---|
| `TRELLO_API_KEY` | Trello API key |
| `TRELLO_TOKEN` | Trello OAuth token (generated from bot account) |
| `GITHUB_TOKEN` | GitHub PAT |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret |
| `ANTHROPIC_API_KEY` | Anthropic API key |

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

1. **Trello webhook** fires when you tag `@claude` on a card
2. **Orchestrator** enqueues a `new-task` job
3. **Worker** clones the repo into a persistent Docker volume, spins up a container
4. **Claude Code** (inside the container) reads the card via Trello MCP, installs deps via `mise`, codes, tests (including Playwright visual tests), opens a PR, moves card to Done
5. **Human comments** on the card → another webhook → orchestrator re-uses the same volume, runs Claude again with the feedback as a follow-up prompt
6. **PR merged/closed** → GitHub webhook → orchestrator destroys the container and volume

## Setup

### 1. Clone and configure

```bash
cp .env.example .env
# Fill in all values in .env
```

### 2. Get your Trello IDs

- **Board ID**: open your Trello board → the ID is in the URL (`trello.com/b/<BOARD_ID>/...`)
- **Done list ID**:
  ```bash
  curl "https://api.trello.com/1/boards/<BOARD_ID>/lists?key=<KEY>&token=<TOKEN>"
  ```
- **Webhook secret**: generate any random string for `TRELLO_WEBHOOK_SECRET`

### 3. Create a Trello bot account

Create a Trello account for Claude (e.g., `claude-bot`). Set `TRELLO_CLAUDE_USERNAME=claude-bot` in `.env`. Add it to your board.

### 4. Build and run

```bash
# Build both images — worker first (takes a few minutes), then orchestrator
docker compose build worker
docker compose up --build -d
```

### 5. Register webhooks

**Trello** (once the server is publicly reachable):
```bash
curl -X POST "https://api.trello.com/1/webhooks?key=<KEY>&token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "callbackURL": "https://your-server.example.com/webhooks/trello",
    "idModel": "<BOARD_ID>",
    "description": "Claude SWE Agent"
  }'
```

**GitHub** (for auto-cleanup on PR close/merge):
- Go to your repo → Settings → Webhooks → Add webhook
- Payload URL: `https://your-server.example.com/webhooks/github`
- Content type: `application/json`
- Secret: same as `GITHUB_WEBHOOK_SECRET` in `.env`
- Events: select "Pull requests" only

For local development, use [ngrok](https://ngrok.com):
```bash
ngrok http 3000
```

## Using it

1. Create a Trello card with a clear task description
2. Include the target repo in the description:
   ```
   repo: https://github.com/myorg/my-app
   ```
3. For frontend tasks, attach screenshot/mockup images to the card
4. Add the Claude bot as a member of the card
5. Claude will:
   - Spin up an isolated container
   - Detect the project type and install all dependencies
   - Code the solution, run tests
   - For frontend: take Playwright screenshots and iterate until it matches designs
   - Open a PR, move the card to Done, post the PR link
6. Comment on the card to give feedback → Claude reads it, updates the PR

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/workers` | List active worker containers |
| `HEAD/POST` | `/webhooks/trello` | Trello webhook |
| `POST` | `/webhooks/github` | GitHub webhook (PR closed → cleanup) |

## Project structure

```
Dockerfile              — Orchestrator (slim: webhook server + queue)
Dockerfile.worker       — Worker image (fat: mise, Claude Code, Playwright, gh, build tools)
worker-entrypoint.sh    — Container entrypoint: set up MCP config, run Claude
docker-compose.yml      — Orchestrator + Redis (worker built as image only)

src/
  index.ts              — Express server, routes
  config.ts             — Zod-validated env vars
  logger.ts             — Pino structured logging
  webhook/
    handler.ts          — Trello + GitHub webhook signature verification, event routing
    types.ts            — Payload types for both webhooks
  queue/
    queue.ts            — BullMQ queue definition
    worker.ts           — Job processor (new-task, feedback, cleanup)
  containers/
    manager.ts          — Docker container lifecycle (create, run, destroy via dockerode)
  workspace/
    repo.ts             — Extract repo URL from card description
  trello/
    api.ts              — Thin Trello client for error comments
  agent/
    prompt.ts           — Build prompts for Claude Code

mcp/
  trello-server/        — MCP server baked into worker image
    index.ts            — Tools: get_card, move_card, add_comment, get_card_comments, get_board_lists
```

## Environment variables

| Variable | Description |
|---|---|
| `TRELLO_API_KEY` | Trello API key |
| `TRELLO_TOKEN` | Trello auth token |
| `TRELLO_WEBHOOK_SECRET` | Secret for Trello webhook signature |
| `TRELLO_DONE_LIST_ID` | List ID of your "Done" column |
| `TRELLO_BOARD_ID` | Board ID to watch |
| `TRELLO_CLAUDE_USERNAME` | Trello username of the bot (default: `claude`) |
| `GITHUB_TOKEN` | GitHub PAT (needs repo + PR permissions) |
| `GITHUB_WEBHOOK_SECRET` | Secret for GitHub webhook signature |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude Code |
| `WEBHOOK_BASE_URL` | Public URL of this server |
| `WORKER_IMAGE` | Docker image for worker containers (default: `claude-swe-worker:latest`) |
| `DEFAULT_GITHUB_REPO` | Fallback repo URL if card doesn't specify one |
| `REDIS_HOST` | Redis host (default: `redis`) |
| `REDIS_PORT` | Redis port (default: `6379`) |
| `PORT` | HTTP server port (default: `3000`) |

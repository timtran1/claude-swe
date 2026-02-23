# Claude SWE Agent

Autonomous development agent: tag `@claude` on a Trello card → Claude codes it, tests it, opens a PR, and moves the card to Done. When humans comment on the card, Claude reads the feedback and updates the PR.

## How it works

```
Trello card (@claude tagged)
  → Webhook → Task queue → Claude Code CLI (with Trello + Playwright MCP servers)
    → Commits code → Opens PR → Moves card to Done → Posts PR link on card

Human comments on card
  → Webhook → Task queue → Claude Code CLI
    → Reads comment → Updates code → Pushes to PR → Replies on card
```

## Setup

### 1. Clone and configure

```bash
cp .env.example .env
# Fill in all values in .env
```

### 2. Get your Trello IDs

- **Board ID**: open your Trello board, click Share → the ID is in the URL (`trello.com/b/<BOARD_ID>/...`)
- **Done list ID**: use the Trello API or run:
  ```bash
  curl "https://api.trello.com/1/boards/<BOARD_ID>/lists?key=<KEY>&token=<TOKEN>"
  ```
- **Webhook secret**: generate any random string, set it in `.env` as `TRELLO_WEBHOOK_SECRET`

### 3. Create a Trello bot account

Create a Trello account for Claude (e.g., username `claude-bot`). Set `TRELLO_CLAUDE_USERNAME=claude-bot` in `.env`. Add this account to your board.

### 4. Register the Trello webhook

Once the server is running and publicly reachable:

```bash
curl -X POST "https://api.trello.com/1/webhooks?key=<KEY>&token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "callbackURL": "https://your-server.example.com/webhooks/trello",
    "idModel": "<BOARD_ID>",
    "description": "Claude SWE Agent"
  }'
```

For local development, use [ngrok](https://ngrok.com):
```bash
ngrok http 3000
# Use the https URL as WEBHOOK_BASE_URL in .env
```

### 5. Run

```bash
docker-compose up --build
```

## Using it

1. Create a Trello card with a clear task description
2. Include the target GitHub repo in the description:
   ```
   repo: https://github.com/myorg/my-app
   ```
   Or set `DEFAULT_GITHUB_REPO` in `.env` as a fallback.
3. For frontend tasks, attach screenshot/mockup images to the card
4. Add the Claude bot account as a member of the card
5. Watch Claude work — it will post the PR link as a card comment when done

## Project structure

```
src/
  index.ts          — Express server, webhook endpoints
  config.ts         — Env var validation
  logger.ts         — Pino logger
  webhook/
    handler.ts      — Signature verification, event routing
    types.ts        — Trello webhook payload types
  queue/
    queue.ts        — BullMQ queue
    worker.ts       — Job processor
  trello/
    api.ts          — Thin Trello REST client (for orchestrator use only)
  workspace/
    setup.ts        — Clone repo, create branch, write MCP config
  agent/
    runner.ts       — Spawn Claude Code CLI subprocess
    prompt.ts       — Build task prompts

mcp/
  trello-server/    — MCP server exposing Trello tools to Claude during its run
    index.ts        — Tools: get_card, move_card, add_comment, get_card_comments, get_board_lists
```

## Environment variables

| Variable | Description |
|---|---|
| `TRELLO_API_KEY` | Trello API key |
| `TRELLO_TOKEN` | Trello auth token |
| `TRELLO_WEBHOOK_SECRET` | Secret for webhook signature verification |
| `TRELLO_DONE_LIST_ID` | List ID of your "Done" column |
| `TRELLO_BOARD_ID` | Board ID to watch |
| `TRELLO_CLAUDE_USERNAME` | Trello username of the Claude bot account (default: `claude`) |
| `GITHUB_TOKEN` | GitHub personal access token (needs repo + PR permissions) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `WEBHOOK_BASE_URL` | Public URL of this server |
| `DEFAULT_GITHUB_REPO` | Fallback repo URL if card doesn't specify one |
| `CLAUDE_TIMEOUT_MS` | Max time for Claude Code to run per task (default: 1800000 = 30min) |
| `REDIS_HOST` | Redis host (default: `redis`) |
| `REDIS_PORT` | Redis port (default: `6379`) |
| `PORT` | HTTP server port (default: `3000`) |

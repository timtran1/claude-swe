# Claude SWE Agent

Autonomous development agent: assign the Claude bot user to a Trello card, mention the bot in Slack, or assign a Jira issue to the bot → Claude codes it, tests it, opens a PR, and moves the task to Done. When humans comment on the card/issue or reply in the Slack thread, Claude reads the feedback and updates the PR.

Each task runs in its own isolated Docker container with persistent storage. The container has `mise` (universal runtime manager) so Claude auto-detects and installs whatever the project needs — Node, Python, Go, Rust, Ruby, etc. When the PR is merged or closed, the container and volume are automatically cleaned up.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Orchestrator (lightweight Node.js server)            │
│                                                      │
│  Trello webhook ─┬─► Task Queue (BullMQ/Redis)       │
│  GitHub webhook  │        │                          │
│  Jira webhook   ─┤        ▼                          │
│  Slack (Socket) ─┘  Container Manager (docker/k8s)  │
│                    │           │          │          │
│                    ▼           ▼          ▼          │
│               ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│               │Worker #1│ │Worker #2│ │Worker #3│   │
│               │(task A) │ │(task B) │ │(task C) │   │
│               └────┬────┘ └────┬────┘ └────┬────┘   │
│                    │           │           │        │
│                  vol-A       vol-B       vol-C      │
│                (persist)   (persist)   (persist)    │
└──────────────────────────────────────────────────────┘

Each worker container has:
  mise, Claude Code CLI, Playwright + Chromium, gh CLI,
  build-essential, python3, Trello MCP server (optional)
```

### Lifecycle

1. **Trello webhook** fires when you assign the bot user to a card in a watched list — OR — **Jira webhook** when you assign the bot account to an issue — OR — **Slack** when you `@mention` the bot in a channel
2. **Orchestrator** enqueues a `new-task` job
3. **Worker** clones the repo into a persistent Docker volume, spins up a container
4. **Claude Code** (inside the container) reads the task description, installs deps via `mise`, codes, tests (including Playwright visual tests), opens a PR. For Trello tasks: reads card via Trello MCP and moves card to Done. For Jira tasks: posts a comment with the PR link and transitions the issue to Done.
5. **Human comments** on the card/issue (or replies in the Slack thread) → a Haiku guard call classifies the comment: (a) human-to-human chatter is silently skipped; (b) **operational commands** (`stop`, `move <status>`, `restart`, `archive`) are executed immediately by the orchestrator without spinning up a container; (c) code feedback kills any running container for that task and re-runs Claude with the comment as a follow-up prompt
6. **PR merged/closed** → GitHub webhook → orchestrator destroys the container and volume; notifies Slack thread if applicable
7. **Card archived** → Trello webhook → orchestrator drains any pending jobs and destroys the container and volume

## Setup

### 1. Create a Trello bot account

Create a Trello account for Claude (e.g., `claude-bot`) and add it to your board. This is the account that will be assigned to cards to trigger tasks and will post comments.

### 2. Get Trello credentials

**API key and secret**: go to `https://trello.com/app-key`. The page shows your **API Key** and, after clicking "show", your **Secret**. Save both — the key goes in `TRELLO_API_KEY` and the secret in `TRELLO_API_SECRET`. The secret is used to verify that incoming webhook requests genuinely come from Trello.

**Token**: log in to Trello as the bot account, then visit:
```
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=claude-swe&key=YOUR_API_KEY
```
Approve and copy the token. Comments and card moves will appear as this bot account.

### 3. Get Anthropic credentials

Go to [console.anthropic.com](https://console.anthropic.com), sign in, and navigate to **API Keys**. Create a new key and copy it — this is your `ANTHROPIC_API_KEY`.

### 4. Get GitHub credentials

**Personal Access Token (PAT)**:

Go to [github.com/settings/tokens](https://github.com/settings/tokens) and choose the token type that matches your setup:

| Situation | Token type | Scopes / permissions |
|---|---|---|
| Single user or single org | Fine-grained | **Contents** (read & write), **Pull requests** (read & write), **Workflows** (read & write) — scope to specific repos |
| Multiple orgs / all repos | Classic | `repo`, `workflow` |

> **Note:** The `workflow` scope (classic) / Workflows permission (fine-grained) is required to push changes to `.github/workflows/` files. Without it, GitHub will reject any push that touches workflow files.

Copy the token — this is your `GITHUB_TOKEN`.

**Webhook secret**:
```bash
openssl rand -hex 32
```
Save this value — you'll use it as `GITHUB_WEBHOOK_SECRET` and as the secret when registering the GitHub webhook (see step 6).

### 5. Configure

```bash
cp config.example.json config.json
cp .env.example .env
```

Edit `config.json` — non-sensitive settings live here:

```json
{
  "agent": {
    "planMode": true,
    "models": { "plan": "opus", "execute": "sonnet", "guard": "haiku" },
    "prompts": {
      "plan": "",
      "execute": "",
      "newTask": "",
      "feedback": ""
    }
  },
  "trello": {
    "apiKey": "env.TRELLO_API_KEY",
    "apiSecret": "env.TRELLO_API_SECRET",
    "token": "env.TRELLO_TOKEN",
    "botUsername": "claude-bot",
    "boards": [
      {
        "name": "My Project Board",
        "includeLists": ["To Do", "In Progress"],
        "doing": { "list": "In Progress" },
        "done": { "list": "Done" }
      }
    ]
  },
  "slack": {
    "botToken": "env.SLACK_BOT_TOKEN",
    "appToken": "env.SLACK_APP_TOKEN",
    "signingSecret": "env.SLACK_SIGNING_SECRET",
    "channels": {
      "C0123ABCDEF": { "repos": ["https://github.com/myorg/my-app"] }
    }
  },
  "github": {
    "token": "env.GITHUB_TOKEN",
    "webhookSecret": "env.GITHUB_WEBHOOK_SECRET"
  },
  "anthropic": { "apiKey": "env.ANTHROPIC_API_KEY" },
  "server": { "port": 3000, "webhookBaseUrl": "https://your-server.example.com" },
  "redis": { "host": "redis", "port": 6379 },
  "containers": { "backend": "docker", "workerImage": "claude-swe-worker:latest" }
}
```

- **Board and list names**: use human-readable names by default. IDs are also supported if needed (`id`, `listId` instead of `name`, `list`).
- **`includeLists`**: only cards in these lists trigger a task when the bot is assigned. Empty array = react to all lists.
- **`doing`**: optional — if set, the orchestrator moves the card to this list when starting work. Omit to skip.
- **`done`**: optional — if set, this list ID is passed to Claude via the Trello MCP server so it can move the card when appropriate (typically after opening a PR). Omit to skip.
- **`env.KEY`**: any value starting with `env.` is resolved from the environment variable of that name at startup. Missing vars resolve to `null` (graceful degradation, logged on `/health`).

Edit `.env` — secrets only:
```
TRELLO_API_KEY=
TRELLO_API_SECRET=
TRELLO_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_SIGNING_SECRET=
GITHUB_TOKEN=
GITHUB_WEBHOOK_SECRET=
ANTHROPIC_API_KEY=
JIRA_API_TOKEN=
JIRA_WEBHOOK_SECRET=
```

### 6. Build and run

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

### 7. GitHub webhook (for PR cleanup)

When a PR is merged or closed, the orchestrator needs to know so it can destroy the worker container and Docker volume for that task. Without this webhook, containers and volumes accumulate indefinitely.

You can set this up at the repo level or org level — the payload format is identical and the handler works either way. Org-level is simpler if this agent will work across many repos.

**Per-repo**: go to the repo → Settings → Webhooks → Add webhook

**Per-org**: go to your org → Settings → Webhooks → Add webhook (covers all current and future repos in the org)

In both cases:
- Payload URL: `https://your-server.example.com/webhooks/github`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET` in `.env`
- Events: select **Pull requests** only

### 8. Jira (optional)

Jira lets you trigger tasks directly from Jira issues. Assign the bot account to an issue → Claude picks it up, codes the solution, and posts the PR link as a comment. You can also comment on the issue to give feedback.

#### Create a Jira bot account

Create a dedicated Atlassian account for Claude (e.g. `claude-bot@yourorg.com`) and add it as a member of the Jira projects you want it to work on.

#### Get an API token

Log in as the **bot account** and go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Click **Create API token**, give it a name (e.g. `claude-swe`), and copy the token — this is `JIRA_API_TOKEN`. The token is tied to the bot account email.

#### Add to config.json (global bot mode)

In **global bot mode**, the bot responds to any Jira issue assigned to it, across all projects. The target repo must be included in the issue description using a `repo:` line:

```json
"jira": {
  "host": "https://yourorg.atlassian.net",
  "email": "claude-bot@yourorg.com",
  "apiToken": "env.JIRA_API_TOKEN",
  "webhookSecret": "env.JIRA_WEBHOOK_SECRET",
  "doing": { "status": "In Progress" },
  "done":  { "status": "Done" },
  "projects": []
}
```

| Field | Meaning | How to find |
|---|---|---|
| `host` | Your Jira Cloud base URL | Found in browser address bar: `https://<yourorg>.atlassian.net` |
| `email` | Bot account email address | The email you used to create the bot Atlassian account |
| `apiToken` | API token for bot authentication | Generated at id.atlassian.com as above — use `"env.JIRA_API_TOKEN"` |
| `webhookSecret` | Optional HMAC secret to verify webhook payloads | Generate with `openssl rand -hex 32`; must match what you set in Jira → use `"env.JIRA_WEBHOOK_SECRET"` |
| `doing.status` | Transition name to move the issue to when starting work | Must match a transition name in your Jira workflow exactly |
| `doing.statusId` | Transition ID (alternative to name — no extra API call) | From `GET /rest/api/3/issue/{issueKey}/transitions` or Jira workflow editor |
| `done.status` | Transition name to move the issue to when PR is opened | Same workflow as above |
| `done.statusId` | Transition ID for the Done transition | Same as above |
| `projects` | Per-project config entries (empty = global mode) | See per-project mode below |

#### Per-project mode (optional)

Add entries to `projects[]` to configure specific repos and custom transitions per Jira project. The bot no longer needs a `repo:` line in the issue description:

```json
"jira": {
  "host": "https://yourorg.atlassian.net",
  "email": "claude-bot@yourorg.com",
  "apiToken": "env.JIRA_API_TOKEN",
  "doing": { "status": "In Progress" },
  "done":  { "status": "Done" },
  "projects": [
    {
      "key": "MYAPP",
      "repos": ["https://github.com/myorg/my-app"],
      "includedStatuses": ["To Do", "Backlog"],
      "doing": { "statusId": "21" },
      "done":  { "statusId": "31" }
    }
  ]
}
```

| Per-project field | Meaning |
|---|---|
| `key` | Jira project key (e.g. `MYAPP`) — shown in issue keys like `MYAPP-123` |
| `repos` | GitHub repos to clone for this project |
| `includedStatuses` | Only trigger tasks when the issue is currently in one of these statuses (empty = any status) |
| `doing` / `done` | Override the global transition — use `status` (name) or `statusId` (faster, no API call) |

Both modes can coexist: projects with explicit entries use per-project config; all other projects fall through to global mode.

#### Add secrets to .env

```
JIRA_API_TOKEN=
JIRA_WEBHOOK_SECRET=
```

#### Webhook auto-registration

On startup the orchestrator automatically registers a Jira dynamic webhook via `POST /rest/api/3/webhook`. Dynamic webhooks expire after 30 days; the orchestrator refreshes them automatically on each restart when they are within 7 days of expiry.

> **Permission required:** The bot account needs the **Administer Jira** global permission to register system-wide webhooks via the API. If the bot lacks this permission, webhook registration is skipped with a warning and manual setup instructions logged. You can then register the webhook manually:
> 1. Go to Jira Settings → System → Webhooks → Create webhook
> 2. URL: `https://your-server.example.com/webhooks/jira`
> 3. Events: **Issue updated**, **Comment created**, **Issue deleted**

#### Global mode: issue description format

When using global mode (no per-project config), include the target repo in the issue description so the bot can find it:

```
Implement a dark mode toggle on the settings page.

repo: https://github.com/myorg/my-app
```

If no repo is found, the bot posts a comment on the issue asking you to add one, then waits for the next edit.

### 9. Slack app (optional)

Slack lets you trigger tasks and give feedback without Trello. You can use Slack alongside Trello (any combination), or Slack-only if you don't have Trello configured.

**Create the Slack app:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**
2. Enable **Socket Mode**: go to Settings → Socket Mode → toggle on. Generate an **app-level token** with the `connections:write` scope — this is your `SLACK_APP_TOKEN` (starts with `xapp-`)
3. Add **Bot Token Scopes** under OAuth & Permissions → Scopes → Bot Token Scopes:
   - `app_mentions:read` — receive `@bot` mentions
   - `chat:write` — post messages
   - `files:read` — read file attachments shared with the bot
   - `channels:history` — read message history in public channels
   - `groups:history` — read message history in private channels
4. Go to **Event Subscriptions** → Enable Events → Subscribe to bot events: add `app_mention`
5. **Install app to workspace** (OAuth & Permissions → Install to Workspace) and copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`)
6. Invite the bot to the channels where you want to use it: `/invite @your-bot-name`

**Configure channel defaults (optional):**

In `config.json`, add default repos for each channel (find the channel ID in Slack: right-click channel → View channel details → scroll down to copy ID):

```json
"slack": {
  "channels": {
    "C0123ABCDEF": { "repos": ["https://github.com/myorg/my-app"] }
  }
}
```

If a channel has no default repos, the bot will ask for a GitHub URL or Trello card URL when you mention it without one.

## Using it

### From Trello

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

### From Jira

1. Create a Jira issue with a clear title and description
2. If using **global bot mode**, include the target repo in the description:
   ```
   repo: https://github.com/myorg/my-app
   ```
   (Per-project mode does not need this — repos are configured in `config.json`)
3. Optionally attach screenshots or mockup images to the issue
4. **Assign the issue to the Claude bot account** — this triggers the task
5. Claude will:
   - Transition the issue to "In Progress" (if `doing` is configured)
   - Spin up an isolated container, clone the repo, install dependencies
   - Code the solution and open a PR
   - Post a comment on the issue with the PR link
   - Transition the issue to "Done" (if `done` is configured)
6. **Comment on the issue** to give feedback → the Haiku guard classifies it:
   - Human-to-human chatter is silently skipped
   - Code feedback triggers a new container run with the comment as a follow-up prompt
   - Operational commands are executed inline:
     - `stop` — kill the running container
     - `move In Progress` — transition the issue to another status
     - `restart` — stop and re-queue as a fresh task
     - `archive` — transition the issue to Done and stop the worker

### From Slack

1. Mention the bot in a channel with a task description and optionally a GitHub repo URL:
   ```
   @claude-bot Add a dark mode toggle to the settings page https://github.com/myorg/my-app
   ```
2. Or link a Trello card to use that card's description and board repos:
   ```
   @claude-bot https://trello.com/c/abc123
   ```
3. If no repo is provided and the channel has no default configured, the bot will ask for one in a reply — just paste a GitHub or Trello URL in the thread
4. You can attach images (screenshots, mockups) directly to the Slack message — they're downloaded and passed to Claude
5. Reply in the thread to give feedback or run commands:
   - `stop` — kill the running container
   - `restart` — stop and re-queue as a fresh task
   - Any other reply → classified by the Haiku guard as feedback or chatter

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Status + credential check (`trello`, `github`, `anthropic`, `slack`, `jira` booleans) |
| `GET` | `/workers` | List active worker containers |
| `HEAD/POST` | `/webhooks/trello` | Trello webhook receiver |
| `POST` | `/webhooks/github` | GitHub webhook (PR closed → cleanup) |
| `POST` | `/webhooks/jira` | Jira webhook (issue assigned/commented/deleted) |
| `GET` | `/logs/:token` | Live log viewer (HTML) for a running worker |
| `GET` | `/logs/:token/stream` | SSE stream of worker container stdout/stderr |

> **Slack** uses Socket Mode — no HTTP endpoint is needed. The bot connects outbound to Slack's servers and receives events over a persistent WebSocket.

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
  notify.ts             — Status dispatcher: routes postStatus() to Trello or Slack (or both)
  webhook/
    handler.ts          — Trello + GitHub webhook verification, board/list filtering, routing
    jira-handler.ts     — Jira webhook HMAC verification, event routing (assign / comment / delete)
    types.ts            — Payload and job types; TaskSource discriminated union; getTaskSource()
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
  slack/
    client.ts           — Bolt app init (Socket Mode), postSlackReply(), isSlackConfigured()
    handler.ts          — app_mention event handler: new tasks and threaded feedback from Slack
    id.ts               — Slack task ID generation (s-<8 base36>) + Redis thread mapping
    files.ts            — Download Slack file attachments for worker containers
  agent/
    prompt.ts           — Build prompts for Claude Code (Trello, Slack, and Jira variants)
    guard.ts            — Haiku-based classifier: ignore / feedback / operation (stop, move, restart, archive)
    operations.ts       — Execute operational commands inline without spinning up a container
  jira/
    api.ts              — Jira REST API v3 client (comments, transitions, attachments, projects)
    adf.ts              — ADF (Atlassian Document Format) parser: extract text and image URLs
    bot.ts              — Bot identity resolver (initJiraBotAccountId, getBotAccountId)
    config.ts           — resolveJiraConfig(): hybrid config resolution + repo extraction from description
    connection.ts       — Startup connectivity check (logs projects the bot has access to)
    webhooks.ts         — Dynamic webhook registration and auto-refresh on startup

scripts/
  download-jira-images.mjs — Downloaded into worker container; fetches Jira attachments + embedded images

mcp/
  trello-server/        — MCP server baked into worker image
    index.ts            — Tools: get_card, move_card, add_comment, get_card_comments, get_board_lists
    download-images.ts  — CLI script run at container startup to fetch card images to /workspace/.card-images/
```

## Config reference

**`config.json`** (non-sensitive — commit-safe with `env.KEY` references):

| Field | Description |
|---|---|
| `agent.planMode` | `true` (default): two-phase Opus plan → Sonnet execute. `false`: single-phase with the execute model only |
| `agent.models.plan` | Model used for the planning phase (default: `"opus"`) |
| `agent.models.execute` | Model used for execution, feedback, and single-phase tasks (default: `"sonnet"`) |
| `agent.models.guard` | Model used to pre-filter feedback comments before spinning up a container (default: `"haiku"`). Human-to-human conversations are silently skipped; only comments directed at the agent trigger the full feedback loop. |
| `agent.prompts.plan` | Extra instructions appended to the planning prompt (optional) |
| `agent.prompts.execute` | Extra instructions appended to the execution prompt (optional) |
| `agent.prompts.newTask` | Extra instructions appended to the single-phase new-task prompt (optional, used when `planMode` is `false`) |
| `agent.prompts.feedback` | Extra instructions appended to the feedback prompt (optional) |
| `trello.apiKey` | Trello API key — use `"env.TRELLO_API_KEY"` |
| `trello.apiSecret` | Trello API secret (from trello.com/app-key) — use `"env.TRELLO_API_SECRET"` |
| `trello.token` | Trello OAuth token (bot account) — use `"env.TRELLO_TOKEN"` |
| `trello.botUsername` | Trello username of the bot account |
| `trello.boards[].name` | Board name to watch (or use `id` for board ID) |
| `trello.boards[].includeLists` | List names that trigger tasks (or use list IDs; empty = all lists) |
| `trello.boards[].doing.list` | List name to move cards to when starting work (or use `listId`; omit to skip) |
| `trello.boards[].done.list` | List name to move cards to when PR is opened (or use `listId`; omit to skip) |
| `slack.botToken` | Slack Bot User OAuth Token (`xoxb-...`) — use `"env.SLACK_BOT_TOKEN"` |
| `slack.appToken` | Slack app-level token (`xapp-...`) for Socket Mode — use `"env.SLACK_APP_TOKEN"` |
| `slack.signingSecret` | Slack signing secret (optional, for request verification) — use `"env.SLACK_SIGNING_SECRET"` |
| `slack.channels` | Map of Slack channel ID → `{ repos: string[] }` for per-channel default repos |
| `jira.host` | Jira Cloud base URL (e.g. `https://yourorg.atlassian.net`) |
| `jira.email` | Bot account email address |
| `jira.apiToken` | API token for bot account — use `"env.JIRA_API_TOKEN"` |
| `jira.webhookSecret` | Optional HMAC-SHA256 secret to verify webhook payload authenticity — use `"env.JIRA_WEBHOOK_SECRET"` |
| `jira.doing.status` | Transition name to move issues to when starting work (matched case-insensitively via API) |
| `jira.doing.statusId` | Transition ID for the Doing transition (preferred — no extra API call at event time) |
| `jira.done.status` | Transition name to move issues to when PR is opened |
| `jira.done.statusId` | Transition ID for the Done transition |
| `jira.projects` | Array of per-project overrides (empty = global bot mode, watches all projects) |
| `jira.projects[].key` | Jira project key (e.g. `MYAPP`) |
| `jira.projects[].repos` | GitHub repo URLs for this project |
| `jira.projects[].includedStatuses` | Only trigger on issues currently in these statuses (empty = any status) |
| `jira.projects[].doing` | Per-project Doing transition override (`status` or `statusId`) |
| `jira.projects[].done` | Per-project Done transition override (`status` or `statusId`) |
| `github.token` | GitHub PAT (`repo` + `workflow` scopes, or fine-grained with Contents/PRs/Workflows write) — use `"env.GITHUB_TOKEN"` |
| `github.webhookSecret` | GitHub webhook secret — use `"env.GITHUB_WEBHOOK_SECRET"` |
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
| `TRELLO_API_SECRET` | Trello API secret — used to verify webhook signatures |
| `TRELLO_TOKEN` | Trello OAuth token (generated from bot account) |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Slack app-level token for Socket Mode (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret (optional) |
| `GITHUB_TOKEN` | GitHub PAT |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `JIRA_API_TOKEN` | Jira API token (generated from bot account at id.atlassian.com) |
| `JIRA_WEBHOOK_SECRET` | Optional secret to verify Jira webhook signatures (generate with `openssl rand -hex 32`) |

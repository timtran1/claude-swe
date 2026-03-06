# CLAUDE.md

<!-- Check for `CLAUDE.local.md` in the repo root — if it exists, read it.  -->

## Architecture

This is a **Trello-to-PR automation system**. When you assign a bot account to a Trello card, the system spins up an isolated Docker container (or Kubernetes Job) running Claude Code, which codes the solution, opens a PR, and moves the card to Done.

### Orchestrator (Node.js / Express)

The main process (`src/index.ts`) is a thin webhook server + BullMQ job processor. It does **not** run Claude Code directly — it only manages containers and queues.

**Request flow:**
1. Trello webhook (`POST /webhooks/trello`) → `src/webhook/handler.ts` verifies HMAC-SHA1 signature and routes by action type:
   - `addMemberToCard` (bot assigned) → enqueues `new-task` job
   - `removeMemberFromCard` (bot removed) → enqueues `cancel` job
   - `commentCard` (human comment) → Haiku guard (`src/agent/guard.ts`) filters non-agent comments → enqueues `feedback` job
2. GitHub webhook (`POST /webhooks/github`) → verifies HMAC-SHA256; on `pull_request closed` for `claude/*` branches → enqueues `cleanup` job
3. BullMQ worker (`src/queue/worker.ts`) dequeues jobs and calls `containers/manager.ts`

### Container Backend

`src/containers/manager.ts` selects the backend (Docker or Kubernetes) from config and delegates to:
- `src/containers/docker.ts` — Docker via dockerode. Containers are named `claude-swe-<cardShortLink>` with volumes `claude-swe-vol-<cardShortLink>`. For feedback jobs, the existing stopped container is reused (prompt injected via tar archive + `putArchive`).
- `src/containers/kubernetes.ts` — Kubernetes Jobs + PVCs.

Worker containers run `worker-entrypoint.sh`, which:
1. Detects feedback fast-path (if `/workspace/.feedback-prompt` exists, skips setup)
2. Writes MCP config (`@delorenj/mcp-server-trello` + Playwright) to `/workspace/.claude/settings.local.json`
3. Downloads card images to `/workspace/.card-images/` via `scripts/download-images.mjs`
4. Runs Claude Code in two-phase mode (Opus plans → writes `/workspace/.plan.md` → Sonnet executes) or single-phase

### Configuration

`src/config.ts` reads `config.json`, recursively resolves `"env.KEY"` string values from environment variables, and validates with Zod. At startup, `resolveNames()` converts human-readable board/list names to Trello IDs via the API.

Config file: `config.json` (copy from `config.example.json`). Secrets: `.env`.

Key config fields: `agent.planMode` (two-phase vs single-phase), `agent.models.{plan,execute,guard}`, `agent.prompts.*` (extra instructions appended to built-in prompts), `containers.backend` (`docker`|`kubernetes`), `containers.concurrency`.

### Agent Prompts

`src/agent/prompt.ts` builds the prompts passed to Claude Code in worker containers:
- `buildPlanPrompt` — instructs Claude to write `/workspace/.plan.md` without implementing code
- `buildExecutePrompt` — instructs Claude to implement from the plan
- `buildNewTaskPrompt` — single-phase (plan + execute in one pass)
- `buildFeedbackPrompt` — handle reviewer comment on existing PR branch

`src/agent/guard.ts` — Haiku-based pre-filter for feedback jobs. Before spinning up a container, calls the Anthropic API with the comment text to classify whether it's actually directed at the agent. Human-to-human conversations are silently skipped. Fails open (processes feedback) on API error.

Custom instructions from `config.json` are appended to each prompt type via `agent.prompts.*`.

### Live Logs

When a task starts, a UUID-token log session is created (`src/logs/store.ts`) and a link is posted to the Trello card. The `/logs/:token` endpoint serves an HTML viewer; `/logs/:token/stream` is SSE streaming the container's stdout/stderr in real time.

### Job Types

- `new-task` — new card assigned to bot; 3 attempts with exponential backoff
- `feedback` — human comment on card; 3 attempts with exponential backoff
- `cleanup` — PR closed; destroy container + volume
- `cancel` — bot removed from card mid-flight; drain pending jobs, kill container, post comment

Branch naming: all Claude branches are `claude/<cardShortLink>`.

## Local Overrides

It contains private, machine-specific instructions (tools available, deployment targets, etc.) that are not checked in.

## Key Conventions

- TypeScript strict mode, NodeNext module resolution — use `.js` extensions in imports
- Pino structured logging via `src/logger.ts`; always use child loggers with `phase` field
- Config values that may be null (credentials not configured) are `string | null` — check before use
- Tests in `test/` (Vitest); tsconfig excludes `test/` from the main build
- Trello IDs are 24-character hex strings; `isId()` in `config.ts` distinguishes them from names
#!/bin/bash
set -euo pipefail

# Activate mise so runtime shims work
eval "$(/root/.local/bin/mise activate bash)" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Docker readiness: if DOCKER_HOST points to a Unix socket (DinD sidecar),
# wait for the daemon to become available before proceeding.
# ---------------------------------------------------------------------------
if [ -n "${DOCKER_HOST:-}" ] && [[ "${DOCKER_HOST}" == unix://* ]]; then
  DOCKER_SOCK="${DOCKER_HOST#unix://}"
  echo "Waiting for Docker daemon at ${DOCKER_HOST}..."
  DOCKER_READY=0
  for i in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      echo "Docker daemon ready (attempt ${i})"
      DOCKER_READY=1
      break
    fi
    sleep 1
  done
  if [ "$DOCKER_READY" -eq 0 ]; then
    echo "WARNING: Docker daemon not ready after 60s — docker commands may fail" >&2
  else
    # chmod so non-root worker user can use the socket without joining the docker group
    chmod 666 "$DOCKER_SOCK" 2>/dev/null || true
    echo "Docker socket permissions opened: ${DOCKER_SOCK}"
  fi
fi

# ---------------------------------------------------------------------------
# Docker cleanup trap: on exit, remove any containers/networks/volumes spawned
# by docker compose during this worker session, scoped by project name.
# ---------------------------------------------------------------------------
_docker_cleanup() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if [ -n "${CARD_SHORT_LINK:-}" ]; then
      echo "=== Docker cleanup: removing test containers for claude-${CARD_SHORT_LINK} ==="
      docker ps -aq --filter "label=com.docker.compose.project=claude-${CARD_SHORT_LINK}" \
        | xargs -r docker rm -f 2>/dev/null || true
      docker network ls -q --filter "label=com.docker.compose.project=claude-${CARD_SHORT_LINK}" \
        | xargs -r docker network rm 2>/dev/null || true
      docker volume ls -q --filter "label=com.docker.compose.project=claude-${CARD_SHORT_LINK}" \
        | xargs -r docker volume rm 2>/dev/null || true
    fi
  fi
}
trap _docker_cleanup EXIT

# ---------------------------------------------------------------------------
# Write MCP config to ~/.claude.json (user-scoped).
# User-scoped MCP is always loaded regardless of project root detection.
# Project-scoped .mcp.json won't work here because /workspace has no .git
# and the agent clones repos into subdirectories that become the project root.
# ---------------------------------------------------------------------------
WORKER_HOME="/home/worker"
cat > "${WORKER_HOME}/.claude.json" <<MCPEOF
{
  "mcpServers": {
    "trello": {
      "command": "npx",
      "args": ["-y", "@delorenj/mcp-server-trello"],
      "env": {
        "TRELLO_API_KEY": "${TRELLO_API_KEY}",
        "TRELLO_TOKEN": "${TRELLO_TOKEN}"
      }
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless", "--browser", "chromium", "--user-data-dir", "/tmp/playwright-mcp"]
    }
  }
}
MCPEOF
chown worker:worker "${WORKER_HOME}/.claude.json"
echo "MCP config written to ${WORKER_HOME}/.claude.json"

# ---------------------------------------------------------------------------
# Feedback fast-path: if the orchestrator wrote a prompt file to the workspace
# (Docker: via putArchive into stopped container; K8s: via init container),
# skip all setup and run claude directly with that prompt.
# ---------------------------------------------------------------------------
if [ -f /workspace/.feedback-prompt ]; then
  PROMPT="$(cat /workspace/.feedback-prompt)"
  rm /workspace/.feedback-prompt

  # Pull latest changes in each repo so feedback sees any commits pushed since the last run
  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  for repo_dir in /workspace/*/; do
    if [ -d "${repo_dir}.git" ]; then
      git config --global --add safe.directory "$repo_dir"
      echo "Pulling latest changes in ${repo_dir}"
      git -C "$repo_dir" pull --rebase --autostash 2>&1 || echo "Warning: git pull failed in ${repo_dir} — continuing"
    fi
  done

  # Re-download card images so Claude sees any images attached via comments since last run
  IMAGE_DIR="/workspace/.card-images"
  COMMENT_IMAGE_DIR="/workspace/.comment-images"
  mkdir -p "$IMAGE_DIR"
  node /opt/mcp/download-images.mjs "${CARD_ID}" "$IMAGE_DIR" --comments "$COMMENT_IMAGE_DIR" \
    || echo "Warning: image download failed — continuing"

  chown -R worker:worker /workspace

  cd /workspace
  gosu worker env HOME="$WORKER_HOME" claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    "$PROMPT" \
    2>&1 | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
fi

# Download card images for visual reference
IMAGE_DIR="/workspace/.card-images"
COMMENT_IMAGE_DIR="/workspace/.comment-images"
mkdir -p "$IMAGE_DIR"
node /opt/mcp/download-images.mjs "${CARD_ID}" "$IMAGE_DIR" --comments "$COMMENT_IMAGE_DIR" \
  || echo "Warning: image download failed or no images found — continuing"

# Configure git
git config --global user.name "Claude SWE"
git config --global user.email "claude-swe@noreply.example.com"

# Auth gh CLI
echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true

# Ensure worker user owns the workspace (PVC may be root-owned on first mount)
chown -R worker:worker /workspace

cd /workspace

if [ -n "${CLAUDE_PLAN_PROMPT:-}" ]; then
  # Diagnose claude binary accessibility as worker user
  echo "=== Claude binary check ==="
  gosu worker sh -c 'which claude && claude --version' 2>&1 || echo "WARNING: claude not found in worker PATH"

  # Two-phase: Opus plans, Sonnet executes (new tasks)
  echo "=== Phase 1: Planning with ${CLAUDE_PLAN_MODEL:-opus} ==="
  gosu worker env HOME="$WORKER_HOME" claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_PLAN_MODEL:-opus}" \
    --dangerously-skip-permissions \
    "${CLAUDE_PLAN_PROMPT}" \
    2>&1 | node /opt/mcp/worker-logger.js
  # Capture claude's exit code (left side of pipe), not the logger's
  PLAN_EXIT=${PIPESTATUS[0]}
  if [ "$PLAN_EXIT" -ne 0 ]; then
    echo "ERROR: Planning phase exited with code ${PLAN_EXIT}" >&2
    echo "Check the logs above for the full error from Claude." >&2
    exit "$PLAN_EXIT"
  fi

  if [ ! -f /workspace/.plan.md ]; then
    echo ""
    echo "========================================"
    echo "ERROR: Planning phase completed successfully (exit 0) but did not produce /workspace/.plan.md"
    echo "This means Claude ran without errors but failed to write the plan file."
    echo "The plan prompt instructs Claude to write /workspace/.plan.md — it may have"
    echo "misunderstood the task or encountered an issue reading the Trello card."
    echo "Check the full log output above for details on what Claude did."
    echo "========================================"
    exit 1
  fi

  echo "=== Phase 2: Executing with ${CLAUDE_EXECUTE_MODEL:-sonnet} ==="
  gosu worker env HOME="$WORKER_HOME" claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    "${CLAUDE_EXECUTE_PROMPT}" \
    2>&1 | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
else
  # Single-phase: execute model only (feedback jobs or planMode=false)
  gosu worker env HOME="$WORKER_HOME" claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    "${CLAUDE_PROMPT}" \
    2>&1 | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
fi

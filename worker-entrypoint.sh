#!/bin/bash
set -euo pipefail

# Activate mise so runtime shims work
eval "$(/root/.local/bin/mise activate bash)" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Docker readiness: if DOCKER_HOST points to a Unix socket (DinD sidecar),
# wait for the daemon to become available before proceeding.
# ---------------------------------------------------------------------------
if [ -n "${DOCKER_HOST:-}" ] && [[ "${DOCKER_HOST}" == unix://* ]]; then
  echo "Waiting for Docker daemon at ${DOCKER_HOST}..."
  for i in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      echo "Docker daemon ready (attempt ${i})"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "WARNING: Docker daemon not ready after 30s — docker commands may fail" >&2
    fi
    sleep 1
  done
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
# Write MCP config to a known path and pass it via --mcp-config.
# This is more reliable than settings file discovery (which depends on
# $HOME and project-root detection that varies by Claude Code version).
# ---------------------------------------------------------------------------
MCP_CONFIG="/tmp/mcp-config.json"
cat > "$MCP_CONFIG" <<MCPEOF
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
      "args": ["@playwright/mcp@latest", "--headless"]
    }
  }
}
MCPEOF
echo "MCP config written to ${MCP_CONFIG}"

# ---------------------------------------------------------------------------
# Feedback fast-path: if the orchestrator wrote a prompt file to the workspace
# (Docker: via putArchive into stopped container; K8s: via init container),
# skip all setup and run claude directly with that prompt.
# ---------------------------------------------------------------------------
if [ -f /workspace/.feedback-prompt ]; then
  PROMPT="$(cat /workspace/.feedback-prompt)"
  rm /workspace/.feedback-prompt

  # Pull latest changes in each repo so feedback sees any commits pushed since the last run
  git config --global --add safe.directory /workspace
  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  for repo_dir in /workspace/*/; do
    if [ -d "${repo_dir}.git" ]; then
      echo "Pulling latest changes in ${repo_dir}"
      git -C "$repo_dir" pull --rebase --autostash 2>&1 || echo "Warning: git pull failed in ${repo_dir} — continuing"
    fi
  done

  chown -R worker:worker /workspace

  cd /workspace
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    --mcp-config "$MCP_CONFIG" \
    "$PROMPT" \
    2>&1 | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
fi

# Download card images for visual reference
IMAGE_DIR="/workspace/.card-images"
mkdir -p "$IMAGE_DIR"
node /opt/mcp/download-images.mjs "${CARD_ID}" "$IMAGE_DIR" \
  || echo "Warning: image download failed or no images found — continuing"

# Configure git
git config --global user.name "Claude SWE"
git config --global user.email "claude-swe@noreply.example.com"
git config --global --add safe.directory /workspace

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
  PROMPT_LEN=${#CLAUDE_PLAN_PROMPT}
  echo "DEBUG: Plan prompt length = ${PROMPT_LEN} bytes"
  echo "DEBUG: Plan prompt first 200 chars: ${CLAUDE_PLAN_PROMPT:0:200}"
  echo "DEBUG: Plan prompt last 100 chars: ${CLAUDE_PLAN_PROMPT: -100}"
  echo "DEBUG: Running claude as user $(gosu worker whoami) with model ${CLAUDE_PLAN_MODEL:-opus}"
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_PLAN_MODEL:-opus}" \
    --dangerously-skip-permissions \
    --mcp-config "$MCP_CONFIG" \
    "${CLAUDE_PLAN_PROMPT}" \
    2>&1 | tee /tmp/claude-raw-output.log | node /opt/mcp/worker-logger.js
  # Capture claude's exit code (left side of pipe), not the logger's
  PLAN_EXIT=${PIPESTATUS[0]}
  echo "DEBUG: Claude plan exit code = ${PLAN_EXIT}"
  RAW_LINES=$(wc -l < /tmp/claude-raw-output.log 2>/dev/null || echo 0)
  RAW_BYTES=$(wc -c < /tmp/claude-raw-output.log 2>/dev/null || echo 0)
  echo "DEBUG: Raw claude output = ${RAW_LINES} lines, ${RAW_BYTES} bytes"
  if [ "$RAW_BYTES" -gt 0 ] 2>/dev/null; then
    echo "DEBUG: First 500 chars of raw output:"
    head -c 500 /tmp/claude-raw-output.log
    echo ""
    echo "DEBUG: Last 500 chars of raw output:"
    tail -c 500 /tmp/claude-raw-output.log
    echo ""
  fi
  if [ "$PLAN_EXIT" -ne 0 ]; then
    echo "ERROR: Planning phase exited with code ${PLAN_EXIT}" >&2
    echo "Check the logs above for the full error from Claude." >&2
    exit "$PLAN_EXIT"
  fi

  if [ ! -f /workspace/.plan.md ]; then
    echo "Planning phase did not produce /workspace/.plan.md — skipping execution phase."
    echo "Claude may have determined no action was needed (e.g. comment not directed at it)."
    exit 0
  fi

  echo "=== Phase 2: Executing with ${CLAUDE_EXECUTE_MODEL:-sonnet} ==="
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    --mcp-config "$MCP_CONFIG" \
    "${CLAUDE_EXECUTE_PROMPT}" \
    2>&1 | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
else
  # Single-phase: execute model only (feedback jobs or planMode=false)
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    --mcp-config "$MCP_CONFIG" \
    "${CLAUDE_PROMPT}" \
    2>&1 | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
fi

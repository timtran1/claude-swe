#!/bin/bash
set -euo pipefail

# Activate mise so runtime shims work
eval "$(/root/.local/bin/mise activate bash)"

# Write .claude/settings.local.json with MCP server configs
mkdir -p /workspace/.claude
cat > /workspace/.claude/settings.local.json <<MCPEOF
{
  "mcpServers": {
    "trello": {
      "command": "node",
      "args": ["/opt/mcp/trello-server/dist/index.js"],
      "env": {
        "TRELLO_API_KEY": "${TRELLO_API_KEY}",
        "TRELLO_TOKEN": "${TRELLO_TOKEN}",
        "TRELLO_DONE_LIST_ID": "${TRELLO_DONE_LIST_ID:-}"
      }
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless"]
    }
  }
}
MCPEOF

# Download card images for visual reference
IMAGE_DIR="/workspace/.card-images"
mkdir -p "$IMAGE_DIR"
node /opt/mcp/trello-server/dist/download-images.js "${CARD_ID}" "$IMAGE_DIR" \
  || echo "Warning: image download failed or no images found — continuing"

# Configure git
git config --global user.name "Claude SWE"
git config --global user.email "claude-swe@noreply.example.com"
git config --global --add safe.directory /workspace

# Auth gh CLI
echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true

# Run Claude Code with the prompt passed via CLAUDE_PROMPT env var
cd /workspace
exec claude \
  --print \
  --dangerously-skip-permissions \
  "${CLAUDE_PROMPT}"

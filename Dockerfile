FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright and Chromium
RUN npx playwright install --with-deps chromium

WORKDIR /app

# Install orchestrator dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Install and build the Trello MCP server
COPY mcp/trello-server/package.json mcp/trello-server/package-lock.json* ./mcp/trello-server/
RUN cd mcp/trello-server && npm ci

COPY mcp/trello-server/ ./mcp/trello-server/
RUN cd mcp/trello-server && npm run build

# Copy and build orchestrator source
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Create workspace directory
RUN mkdir -p /tmp/workspaces

EXPOSE 3000

CMD ["node", "dist/src/index.js"]

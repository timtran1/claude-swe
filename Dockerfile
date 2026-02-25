# Orchestrator image — thin. Just runs the webhook server + queue manager.
# Worker containers (Dockerfile.worker) do the actual coding.
FROM node:20-slim

RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

EXPOSE 3000

CMD ["node", "dist/src/index.js"]

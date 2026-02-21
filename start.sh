#!/bin/bash
set -e

# ── Preflight checks ────────────────────────────────────────────────────────

# 1. .env file
if [ ! -f ".env" ]; then
  echo ""
  echo "ERROR: .env file not found."
  echo "  Copy the example and fill in your values:"
  echo ""
  echo "    cp .env.example .env"
  echo ""
  echo "  Required:"
  echo "    CLAUDE_API_KEY  — get yours at https://console.anthropic.com"
  echo ""
  exit 1
fi

# 2. CLAUDE_API_KEY is set and non-empty
source .env
if [ -z "$CLAUDE_API_KEY" ]; then
  echo ""
  echo "ERROR: CLAUDE_API_KEY is not set in your .env file."
  echo "  Get your key at https://console.anthropic.com → API Keys"
  echo "  Then add it to .env:"
  echo ""
  echo "    CLAUDE_API_KEY=sk-ant-..."
  echo ""
  exit 1
fi

# 3. node_modules installed
if [ ! -d "node_modules" ]; then
  echo ""
  echo "ERROR: node_modules not found. Run:"
  echo ""
  echo "    npm install"
  echo ""
  exit 1
fi

# ── Build ───────────────────────────────────────────────────────────────────

echo "Building project..."
npm run build:server

# ── Redis ───────────────────────────────────────────────────────────────────

echo "Starting Redis..."
bash start-redis.sh

# ── Canvas server ───────────────────────────────────────────────────────────

echo ""
echo "Starting canvas server on http://localhost:${PORT:-3000}"
echo ""
set -a && source .env && set +a
exec node dist/server.js

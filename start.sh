#!/bin/bash
set -e

echo "Building project..."
npm run build:server

echo "Starting Redis..."
bash start-redis.sh

echo "Starting canvas server..."
set -a && source .env && set +a
exec node dist/server.js

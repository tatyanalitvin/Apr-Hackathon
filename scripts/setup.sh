#!/usr/bin/env bash
# One-shot setup. Run after cloning.
set -euo pipefail

echo "➡️  Installing dependencies..."
pnpm install

echo "➡️  Creating .env from template..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    created .env — adjust SESSION_SECRET etc. before docker compose up"
else
  echo "    .env already exists, skipping"
fi

echo "➡️  Installing Playwright browsers..."
pnpm exec playwright install --with-deps chromium || true

echo "➡️  Running type check across workspaces..."
pnpm typecheck || echo "    (typecheck failures expected until S1 wires auth/db)"

echo ""
echo "✅ Setup complete. Next:"
echo "   1. Review .env"
echo "   2. docker compose up --build   (or: pnpm dev for local web+backend)"
echo "   3. In another terminal: claude  (then /catchup)"

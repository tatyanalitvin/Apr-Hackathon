#!/usr/bin/env bash
# One-shot setup. Run after cloning.
set -euo pipefail

echo "➡️  Installing dependencies..."
pnpm install

echo "➡️  Creating .env.local from template..."
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "    created .env.local — now open it and paste your ANTHROPIC_API_KEY"
else
  echo "    .env.local already exists, skipping"
fi

echo "➡️  Installing Playwright browsers..."
pnpm exec playwright install --with-deps chromium || true

echo "➡️  Running type check..."
pnpm typecheck

echo "➡️  Running unit tests..."
pnpm test:run

echo ""
echo "✅ Setup complete. Next:"
echo "   1. Edit .env.local with your ANTHROPIC_API_KEY"
echo "   2. pnpm dev"
echo "   3. In another terminal: claude  (then /catchup)"

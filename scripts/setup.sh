#!/usr/bin/env bash
# One-shot setup for apps/harness-app: pull secrets from Doppler into its .env,
# then install its dependencies.
#
# Doppler project/config default to the harness-app dev environment; override
# per-run, e.g.:  DOPPLER_CONFIG=prod scripts/setup.sh
set -euo pipefail

# Repo root is the parent of this script's dir; the app lives in apps/harness-app.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/harness-app"

DOPPLER_PROJECT="${DOPPLER_PROJECT:-ai-playground-harness-app}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-dev}"

if ! command -v doppler >/dev/null 2>&1; then
  echo "✗ doppler CLI not found. Install it: https://docs.doppler.com/docs/install-cli" >&2
  exit 1
fi

cd "$APP_DIR"

echo "→ Pulling secrets from Doppler ($DOPPLER_PROJECT/$DOPPLER_CONFIG) into apps/harness-app/.env"
doppler secrets download --no-file --format env \
  --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" > .env
echo "  wrote $(grep -c '=' .env) vars to .env"

echo "→ Installing dependencies (pnpm)"
pnpm install --ignore-workspace

echo "✓ Setup complete. Run 'pnpm dev' in apps/harness-app to start the server + web."

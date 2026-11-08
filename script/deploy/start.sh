#!/usr/bin/env bash
# CUIT XCPC TOOL (TS) quick start: install deps, build admin if missing, run server.
set -euo pipefail
cd "$(dirname "$0")/../../.."

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is not installed. See script/deploy/deploy.md" >&2
  exit 1
fi

if [ ! -d apps/server/static ] || [ -z "$(ls -A apps/server/static 2>/dev/null)" ]; then
  echo "Building admin frontend..."
  (cd apps/admin && bun install && bun run build)
fi

cd apps/server
bun install
exec bun run src/index.ts

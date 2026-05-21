#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
NODE="$(command -v node)"

cd "$ROOT"

echo "== Zenith MCP SQLite/native binding repair =="
echo "root: $ROOT"
echo "node: $($NODE -v)"

if [[ -f package-lock.json ]]; then
  echo "Removing stale npm package-lock.json"
  rm -f package-lock.json
fi

if [[ -d "$ROOT/Zenith-MCP" ]]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  echo "Moving nested deployment debris to $ROOT/.trash-Zenith-MCP-$stamp"
  mv "$ROOT/Zenith-MCP" "$ROOT/.trash-Zenith-MCP-$stamp"
fi

echo "Using pnpm already on PATH"

echo "pnpm: $(pnpm --version)"

echo "Keeping pnpm-managed better-sqlite3 links intact"

echo "Installing workspace deps with approved native builds"
if ! pnpm install --frozen-lockfile; then
  echo "Frozen install failed; retrying normal pnpm install so lock/config can reconcile"
  pnpm install
fi

echo "Rebuilding better-sqlite3 native binding"
pnpm --filter zenith-mcp rebuild better-sqlite3 --pending || pnpm --filter zenith-mcp rebuild better-sqlite3

echo "Verifying better-sqlite3 loads from zenith-mcp package"
(
  cd "$ROOT/packages/zenith-mcp"
  "$NODE" -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.close(); console.log("better-sqlite3 OK")'
)

echo "SQLite/native binding repair complete."
echo "Build/test are intentionally not run by this repair script."

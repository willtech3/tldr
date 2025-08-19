#!/usr/bin/env bash
set -euo pipefail

# Purpose: Run the repository's full quality gate exactly as CI does
# Mirrors the justfile's default target (qa)

if ! command -v just >/dev/null 2>&1; then
  echo "[agent-run-qa] 'just' is required. Run ./scripts/agent-setup.sh first." >&2
  exit 1
fi

echo "[agent-run-qa] Running 'just qa'"
just qa

echo "[agent-run-qa] Completed successfully"



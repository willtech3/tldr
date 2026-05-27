#!/usr/bin/env bash
set -euo pipefail

# Purpose: Prepare a non-interactive environment for CI/agents (Codex/Jules)
# - Installs `just`
# - Installs Node 20+ deps for the Bolt Lambda and CDK
# - Warms npm caches so `just qa` runs end-to-end

echo "[agent-setup] Starting environment bootstrap"

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# 1) just
if ! has_cmd just; then
  echo "[agent-setup] Installing 'just'"
  if has_cmd brew; then
    brew install just || true
  elif has_cmd apt-get; then
    sudo apt-get update -y || true
    sudo apt-get install -y just || true
  elif has_cmd dnf; then
    sudo dnf install -y just || true
  else
    echo "[agent-setup] Could not install 'just' automatically. See https://github.com/casey/just"
  fi
else
  echo "[agent-setup] 'just' already present"
fi

# 2) Node & npm dependencies for the Bolt Lambda + CDK
if has_cmd node && has_cmd npm; then
  echo "[agent-setup] Node: $(node -v)  npm: $(npm -v)"
  for project in cdk bolt-ts; do
    if [ -d "$project" ]; then
      pushd "$project" >/dev/null
      echo "[agent-setup] Installing $project dependencies"
      if [ -f package-lock.json ]; then
        npm ci --silent || npm install --silent
      else
        npm install --silent
      fi
      popd >/dev/null
    fi
  done
  # Warm the CDK build so subsequent runs are fast.
  if [ -d "cdk" ]; then
    (cd cdk && npm run --silent build || true)
  fi
else
  echo "[agent-setup] Node/npm not found. Install Node 20+ to enable Bolt and CDK builds."
fi

echo "[agent-setup] Done. You can now run ./scripts/agent-run-qa.sh"

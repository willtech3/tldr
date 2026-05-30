#!/usr/bin/env bash
set -euo pipefail

# Purpose: Prepare a non-interactive environment for CI/agents (Codex/Jules)
# - Installs `just`
# - Installs Node 20+ deps for the Bolt Lambda
# - Warms npm + Terraform provider caches so `just qa` runs end-to-end

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

# 2) Node & npm dependencies for the Bolt Lambda
if has_cmd node && has_cmd npm; then
  echo "[agent-setup] Node: $(node -v)  npm: $(npm -v)"
  if [ -d "bolt-ts" ]; then
    pushd "bolt-ts" >/dev/null
    echo "[agent-setup] Installing bolt-ts dependencies"
    if [ -f package-lock.json ]; then
      npm ci --silent || npm install --silent
    else
      npm install --silent
    fi
    popd >/dev/null
  fi
else
  echo "[agent-setup] Node/npm not found. Install Node 20+ to enable Bolt builds."
fi

# 3) Terraform (infra). Warm the provider cache so `just tf-validate` is fast.
if has_cmd terraform; then
  echo "[agent-setup] Terraform: $(terraform version | head -n1)"
  if [ -d "terraform" ]; then
    (cd terraform && terraform init -backend=false -input=false >/dev/null 2>&1 || true)
  fi
else
  echo "[agent-setup] 'terraform' not found. Install Terraform >= 1.10: https://developer.hashicorp.com/terraform/install"
fi

echo "[agent-setup] Done. You can now run ./scripts/agent-run-qa.sh"

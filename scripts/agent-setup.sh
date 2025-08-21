#!/usr/bin/env bash
set -euo pipefail

# Purpose: Prepare a non-interactive environment for CI/agents (Codex/Jules)
# - Installs just, Rust toolchain components, Node 18+ deps for CDK
# - Warms caches and ensures `just qa` can run end-to-end

echo "[agent-setup] Starting environment bootstrap"

unameOut="$(uname -s)"
case "${unameOut}" in
    Linux*)   platform=linux;;
    Darwin*)  platform=darwin;;
    *)        platform=unknown;;
esac

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

# 2) Rust toolchain
if ! has_cmd rustc; then
  echo "[agent-setup] Installing Rust toolchain via rustup (non-interactive)"
  curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
  export PATH="$HOME/.cargo/bin:$PATH"
else
  echo "[agent-setup] Rust toolchain detected: $(rustc --version)"
fi

# Ensure components
rustup component add rustfmt clippy || true

# 3) cargo-lambda (optional for local runs)
if ! has_cmd cargo-lambda; then
  echo "[agent-setup] Installing cargo-lambda (optional)"
  cargo install cargo-lambda || true
fi

# 4) Node & npm dependencies for CDK
if has_cmd node && has_cmd npm; then
  echo "[agent-setup] Node: $(node -v)  npm: $(npm -v)"
  if [ -d "cdk" ]; then
    pushd cdk >/dev/null
    # Use ci if lockfile is present, else fall back to install
    if [ -f package-lock.json ]; then
      npm ci --silent || npm install --silent
    else
      npm install --silent
    fi
    npm run --silent build || true
    popd >/dev/null
  fi
else
  echo "[agent-setup] Node/npm not found. Install Node 18+ to enable CDK builds."
fi

# 5) Warm Rust caches
if [ -d "lambda" ]; then
  pushd lambda >/dev/null
  echo "[agent-setup] Warming Cargo caches (check + fmt)"
  cargo fmt --all || true
  cargo check || true
  popd >/dev/null
fi

echo "[agent-setup] Done. You can now run ./scripts/agent-run-qa.sh"



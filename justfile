# Task runner for common developer workflows
# Install: https://github.com/casey/just (e.g., `brew install just`)

set shell := ["bash", "-euxo", "pipefail", "-c"]

# Default target runs the full code quality suite
default: qa

# --- Bolt TypeScript (bolt-ts/) ---

bolt-install:
	cd bolt-ts && npm ci

bolt-build:
	cd bolt-ts && npm run build

bolt-bundle:
	cd bolt-ts && npm run bundle

bolt-lint:
	cd bolt-ts && npm run lint

bolt-test:
	cd bolt-ts && npm test

# --- CDK (TypeScript) ---

cdk-build:
	cd cdk && npm run --silent build

cdk-lint:
	cd cdk && npm run lint

# Aggregate: Code Quality (what CI runs on PRs)
qa: bolt-build bolt-bundle bolt-lint bolt-test cdk-build cdk-lint
	@echo "✅ All code quality checks passed"

# Clean build artifacts and caches
clean:
	cd cdk && rm -rf node_modules dist cdk.out .tsbuildinfo
	cd bolt-ts && rm -rf node_modules dist bundle coverage

	find . -name "*.orig" -type f -delete
	find . -name ".DS_Store" -type f -delete
	@echo "🧹 Cleaned build artifacts and caches"

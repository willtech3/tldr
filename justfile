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

# --- Terraform (terraform/) ---

# Check formatting (non-zero exit if any file needs `terraform fmt`)
tf-fmt:
	terraform -chdir=terraform fmt -check -recursive

# Offline validation: init without a backend, then validate. No AWS creds or
# Lambda bundle required (data.archive_file is not evaluated during validate).
tf-validate:
	terraform -chdir=terraform init -backend=false -input=false >/dev/null
	terraform -chdir=terraform validate

# Aggregate: Code Quality (what CI runs on PRs)
qa: bolt-build bolt-bundle bolt-lint bolt-test tf-fmt tf-validate
	@echo "✅ All code quality checks passed"

# Clean build artifacts and caches
clean:
	cd bolt-ts && rm -rf node_modules dist bundle coverage
	rm -rf terraform/.terraform terraform/.terraform-artifacts

	find . -name "*.orig" -type f -delete
	find . -name ".DS_Store" -type f -delete
	@echo "🧹 Cleaned build artifacts and caches"

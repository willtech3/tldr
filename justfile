# Task runner for common developer workflows
# Install: https://github.com/casey/just (e.g., `brew install just`)

set shell := ["bash", "-euxo", "pipefail", "-c"]

# Default target runs the full code quality suite
default: qa

# --- Rust (lambda/) ---

fmt:
	cd lambda && cargo fmt

fmt-check:
	cd lambda && cargo fmt --all -- --check

clippy:
	cd lambda && cargo clippy --all-targets -- -D warnings -W clippy::pedantic

check:
	cd lambda && cargo check

test:
	cd lambda && cargo test --all-features

# --- CDK (TypeScript) ---

cdk-build:
	cd cdk && npm run --silent build

# Aggregate: Code Quality (what CI runs on PRs)
qa: fmt-check check clippy test cdk-build
	@echo "✅ All code quality checks passed"

# Clean build artifacts and caches
clean:
	cd lambda && cargo clean
	cd cdk && rm -rf node_modules dist cdk.out .tsbuildinfo
	rm -rf lambda/target
	rm -rf lambda/.cargo
	rm -f lambda/Cargo.lock
	find . -name "*.orig" -type f -delete
	find . -name ".DS_Store" -type f -delete
	@echo "🧹 Cleaned build artifacts and caches"



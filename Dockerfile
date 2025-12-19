# Stage 1: Build Rust Worker Lambda
FROM clux/muslrust:stable as rust-builder

# clux/muslrust already includes Rust and the musl target
# Just ensure we have rustfmt component
RUN rustup component add rustfmt

# Install zip utility
RUN apt-get update && apt-get install -y zip

# Set up the Lambda project
WORKDIR /lambda
COPY lambda /lambda/

# Set environment variable to use system OpenSSL
ENV OPENSSL_STATIC=1
ENV OPENSSL_DIR=/usr

# Update Cargo.toml to use vendored OpenSSL
RUN sed -i 's/openssl = .*/openssl = { version = "0.10", features = ["vendored"] }/' Cargo.toml || echo "OpenSSL dependency not found in Cargo.toml"

# Add build argument for debug logs
ARG ENABLE_DEBUG_LOGS=true

# Build only the Rust Worker Lambda (API Lambda is now TypeScript)
RUN if [ "$ENABLE_DEBUG_LOGS" = "true" ]; then \
    echo "Building Worker with debug logs enabled"; \
    cargo build --release --target x86_64-unknown-linux-musl --bin tldr-worker --features "worker debug-logs"; \
else \
    echo "Building Worker with debug logs disabled"; \
    cargo build --release --target x86_64-unknown-linux-musl --bin tldr-worker --features worker; \
fi

# Create Lambda-compatible artifacts for Worker
RUN mkdir -p /lambda/target/lambda/tldr-worker && \
    cp /lambda/target/x86_64-unknown-linux-musl/release/tldr-worker /lambda/target/lambda/tldr-worker/bootstrap

# Create ZIP file for Worker Lambda
RUN cd /lambda/target/lambda/tldr-worker && zip -j function.zip bootstrap && \
    cp /lambda/target/lambda/tldr-worker/function.zip /tldr-worker.zip

# Stage 2: Build Bolt TypeScript Lambda
FROM node:20-slim as ts-builder

# Install zip utility
RUN apt-get update && apt-get install -y zip && rm -rf /var/lib/apt/lists/*

WORKDIR /bolt-ts
COPY bolt-ts/package*.json ./
RUN npm ci

COPY bolt-ts/ ./
RUN npm run bundle

# Create ZIP file for Bolt Lambda
RUN cd bundle && zip -r /tldr-bolt-api.zip .

# Stage 3: Final artifacts image
FROM amazonlinux:2 as artifacts
COPY --from=rust-builder /lambda/target/lambda/tldr-worker/bootstrap /dist/tldr-worker/bootstrap
COPY --from=rust-builder /tldr-worker.zip /tldr-worker.zip
COPY --from=ts-builder /bolt-ts/bundle /dist/tldr-bolt-api/
COPY --from=ts-builder /tldr-bolt-api.zip /tldr-bolt-api.zip
WORKDIR /dist

# Default command prevents the "no command specified" error
CMD ["echo", "Lambda artifacts built successfully"]

# Stage 1: Build Rust Worker Lambda
FROM rust:1.95.0-bookworm@sha256:503651ea31e66ecb74623beabde781059a5978df1595a9e8ed03974d5fec1bf0 AS rust-builder

# Install the musl target and native tools needed for a static Lambda binary.
RUN rustup target add x86_64-unknown-linux-musl && \
    rustup component add rustfmt && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      make \
      musl-tools \
      perl \
      pkg-config \
      zip && \
    rm -rf /var/lib/apt/lists/*

# Set up the Lambda project
WORKDIR /lambda
COPY lambda /lambda/

# Build a static musl binary with vendored OpenSSL.
ENV CC_x86_64_unknown_linux_musl=musl-gcc
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc
ENV OPENSSL_STATIC=1

# Update Cargo.toml to use vendored OpenSSL
RUN sed -i 's/openssl = .*/openssl = { version = "0.10", features = ["vendored"] }/' Cargo.toml || echo "OpenSSL dependency not found in Cargo.toml"

# Add build argument for debug logs. Default is off so production-style local
# builds do not compile prompt logging by accident.
ARG ENABLE_DEBUG_LOGS=false

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
FROM node:20.19.5-bookworm-slim@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3 AS ts-builder

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
FROM amazonlinux:2@sha256:74e5c80ad36e6ef0f6fd4a55bb3cc969c05dec6b9dc27fdfa68c8e77264901f9 AS artifacts
COPY --from=rust-builder /lambda/target/lambda/tldr-worker/bootstrap /dist/tldr-worker/bootstrap
COPY --from=rust-builder /tldr-worker.zip /tldr-worker.zip
COPY --from=ts-builder /bolt-ts/bundle /dist/tldr-bolt-api/
COPY --from=ts-builder /tldr-bolt-api.zip /tldr-bolt-api.zip
WORKDIR /dist

# Default command prevents the "no command specified" error
CMD ["echo", "Lambda artifacts built successfully"]

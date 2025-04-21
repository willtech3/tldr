FROM clux/muslrust:stable as builder

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Explicitly add the musl target for the Rust standard library
RUN rustup target add x86_64-unknown-linux-musl

# Set up the Lambda project
WORKDIR /lambda
COPY lambda /lambda/

# Set environment variable to use system OpenSSL
ENV OPENSSL_STATIC=1
ENV OPENSSL_DIR=/usr

# Update Cargo.toml to use vendored OpenSSL
RUN sed -i 's/openssl = .*/openssl = { version = "0.10", features = ["vendored"] }/' Cargo.toml || echo "OpenSSL dependency not found in Cargo.toml"

# Build for Lambda using MUSL target
RUN cargo build --release --target x86_64-unknown-linux-musl --bin tldr-api --features api && \
    cargo build --release --target x86_64-unknown-linux-musl --bin tldr-worker --features worker

# Create Lambda-compatible artifacts
RUN mkdir -p /lambda/target/lambda/tldr-api && \
    mkdir -p /lambda/target/lambda/tldr-worker && \
    cp /lambda/target/x86_64-unknown-linux-musl/release/tldr-api /lambda/target/lambda/tldr-api/bootstrap && \
    cp /lambda/target/x86_64-unknown-linux-musl/release/tldr-worker /lambda/target/lambda/tldr-worker/bootstrap

# Using a proper runtime image instead of scratch so we can extract files more easily
FROM amazonlinux:2 as artifacts
COPY --from=builder /lambda/target/lambda/tldr-api/bootstrap /dist/tldr-api/bootstrap
COPY --from=builder /lambda/target/lambda/tldr-worker/bootstrap /dist/tldr-worker/bootstrap
WORKDIR /dist

# Default command prevents the "no command specified" error
CMD ["echo", "Lambda artifacts built successfully"]

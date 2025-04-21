FROM amazonlinux:2 as builder

# Install build dependencies
RUN yum update -y && \
    yum install -y \
    gcc \
    gcc-c++ \
    openssl-devel \
    make \
    cmake \
    curl \
    zip \
    unzip \
    git \
    perl \
    perl-IPC-Cmd \
    perl-Data-Dumper \
    && yum clean all

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Set up the Lambda project
WORKDIR /lambda
COPY lambda /lambda/

# Create a config.toml that uses gcc without any problematic rustflags
RUN mkdir -p .cargo
RUN echo '[target.x86_64-unknown-linux-gnu]' > .cargo/config.toml && \
    echo 'linker = "gcc"' >> .cargo/config.toml && \
    echo 'rustflags = ["-C", "target-feature=-crt-static"]' >> .cargo/config.toml

# Set environment variable to use system OpenSSL
ENV OPENSSL_STATIC=1
ENV OPENSSL_DIR=/usr

# Update Cargo.toml to use vendored OpenSSL
RUN sed -i 's/openssl = .*/openssl = { version = "0.10", features = ["vendored"] }/' Cargo.toml || echo "OpenSSL dependency not found in Cargo.toml"

# Build for Lambda
RUN cargo build --release --bin tldr-api --features api && \
    cargo build --release --bin tldr-worker --features worker

# Create Lambda-compatible artifacts
# Lambda expects an executable named 'bootstrap' (not zipped)
RUN mkdir -p /lambda/target/lambda/tldr-api && \
    mkdir -p /lambda/target/lambda/tldr-worker && \
    cp /lambda/target/release/tldr-api /lambda/target/lambda/tldr-api/bootstrap && \
    cp /lambda/target/release/tldr-worker /lambda/target/lambda/tldr-worker/bootstrap

# Using a proper runtime image instead of scratch so we can extract files more easily
FROM amazonlinux:2 as artifacts
COPY --from=builder /lambda/target/lambda/tldr-api/bootstrap /dist/tldr-api/bootstrap
COPY --from=builder /lambda/target/lambda/tldr-worker/bootstrap /dist/tldr-worker/bootstrap
WORKDIR /dist

# Default command prevents the "no command specified" error
CMD ["echo", "Lambda artifacts built successfully"]

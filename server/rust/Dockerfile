# Build stage
FROM rust:alpine AS builder

# Install build dependencies required by aws-lc-rs and others
RUN apk add --no-cache musl-dev gcc g++ cmake make perl linux-headers ca-certificates

WORKDIR /usr/src/app

# Copy project files
COPY . .

# Build a statically linked release binary
RUN cargo build --release

# Final scratch image
FROM scratch

# Copy CA certificates for reqwest/rustls
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy the statically compiled binary
COPY --from=builder /usr/src/app/target/release/frontendmcp-server /frontendmcp-server

# Run the binary
ENTRYPOINT ["/frontendmcp-server"]
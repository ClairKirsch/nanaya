FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# System deps + Podman
RUN apt-get update && apt-get install -y \
    ca-certificates curl gnupg git wget build-essential \
    podman \
    && rm -rf /var/lib/apt/lists/*

# gVisor
RUN set -e \
    && ARCH=$(uname -m) \
    && URL=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH} \
    && wget ${URL}/runsc ${URL}/runsc.sha512 \
        ${URL}/containerd-shim-runsc-v1 ${URL}/containerd-shim-runsc-v1.sha512 \
    && sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512 \
    && rm -f *.sha512 \
    && chmod a+rx runsc containerd-shim-runsc-v1 \
    && mv runsc containerd-shim-runsc-v1 /usr/local/bin

RUN curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
    gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor \
    && echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] \
    https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list \
    && apt-get update \
    && apt-get install -y mongodb-org \
    && rm -rf /var/lib/apt/lists/*

# Podman config for vscode user
COPY containers.conf /etc/containers/containers.conf

# Fix git safe directory for vscode user
RUN git config --global --add safe.directory /workspaces/tohno-backend
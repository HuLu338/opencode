FROM oven/bun:1.3.14-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    golang-go \
    nodejs \
    npm \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /seed
COPY . .
RUN bun install --frozen-lockfile

COPY packages/opencode/sandbox/entrypoint.sh /usr/local/bin/opencode-sandbox
RUN chmod 0555 /usr/local/bin/opencode-sandbox

ENTRYPOINT ["/usr/local/bin/opencode-sandbox"]

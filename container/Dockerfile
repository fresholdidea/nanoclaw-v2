# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The BuildKit frontend above is pinned by digest, so a build fetches it by
# content address and never asks Docker Hub to resolve the `1.7` tag first. The
# tag lookup is the HEAD request that returned 500 and took two registry-skills
# legs down on 2026-09-07 with the code untouched. Resolved with
# `crane digest docker/dockerfile:1.7` (docker buildx imagetools inspect agrees).
# Bump the tag and digest together.
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser) are
# pinned in cli-tools.json so a skill can add one with a json-merge; Bun (the
# runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.4.0

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        python3 \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- mnemon — persistent agent memory ----------------------------------------
# Shared store across host CC and all nanoclaw groups. The host mounts
# ~/.mnemon (RW) at /workspace/extra/mnemon via each group's container.json
# `additionalMounts`, and MNEMON_DATA_DIR below points the binary at it.
#
# The live store is WAL-mode SQLite, which cannot be opened across the macOS
# Docker mount, so the real binary installs as mnemon-real and `mnemon` is a
# shim: reads go to the host-refreshed snapshot, writes queue for host replay
# (drained by src/mnemon-sync.ts). See container/mnemon-shim.sh.
ARG MNEMON_VERSION=0.1.14
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    mv /usr/local/bin/mnemon /usr/local/bin/mnemon-real && \
    chmod +x /usr/local/bin/mnemon-real
COPY mnemon-shim.sh /usr/local/bin/mnemon
COPY mnemon-queue.mjs /usr/local/lib/mnemon-queue.mjs
RUN chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/workspace/extra/mnemon

# ---- notebooklm CLI (nlm) — Google NotebookLM --------------------------------
# `notebooklm-mcp-cli` drives NotebookLM from a portable cookie file. Auth is a
# one-time interactive host `nlm login`; the host then mounts ~/.notebooklm-mcp-cli
# (RW) at /workspace/extra/notebooklm via each group's container.json
# `additionalMounts`, and NOTEBOOKLM_MCP_CLI_PATH below points the CLI at it.
# Queries use profiles/<name>/cookies.json over HTTP — no browser or Playwright is
# needed in-container (login, which drives Chrome over CDP, happens on the host).
# Installed with uv against the system python3 into world-readable /opt so the
# non-root `node` user can execute /usr/local/bin/nlm.
ARG NOTEBOOKLM_CLI_VERSION=0.8.7
ENV UV_TOOL_DIR=/opt/uv/tools
ENV UV_TOOL_BIN_DIR=/usr/local/bin
ENV UV_PYTHON_DOWNLOADS=never
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/usr/local/bin sh && \
    uv tool install --python /usr/bin/python3 "notebooklm-mcp-cli==${NOTEBOOKLM_CLI_VERSION}" && \
    uv cache clean && \
    rm -f /usr/local/bin/uv /usr/local/bin/uvx && \
    chmod -R a+rX /opt/uv

ENV NOTEBOOKLM_MCP_CLI_PATH=/workspace/extra/notebooklm

# ---- deepline CLI ------------------------------------------------------------
# Install the supported npm CLI package directly. The former Python binary
# endpoint (`/api/v2/cli/python`) now returns 404; the package registry is the
# documented, versioned distribution and avoids running Deepline's interactive
# setup during a non-interactive image build.
ARG DEEPLINE_VERSION=0.3.0
RUN npm install --global --ignore-scripts --no-audit --no-fund \
    "deepline@${DEEPLINE_VERSION}" \
    --registry=https://code.deepline.com/api/v2/npm/
ENV DEEPLINE_HOST_URL=https://code.deepline.com

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.34.5
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# The npm bundled with node:22-slim (10.9.8) vendors tar <7.5.19, which
# carries a fixable critical (GHSA-23hp-3jrh-7fpw) that the publish gate
# refuses to ship. Patch-level bump only. Drop this once the base image
# ships npm >= 10.9.9.
ARG NPM_VERSION=10.9.9
RUN npm install -g npm@${NPM_VERSION}

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- gws-account wrapper ------------------------------------------------------
# Same pattern as ncl: the real helper lives in the mounted skills dir at
# /app/skills/google-workspace/gws-account, which is not on PATH. The
# google-workspace SKILL.md documents the bare `gws-account` command, so without
# this shim every group except one with its own private copy hit
# "command not found" and concluded GWS was unavailable to them.
RUN printf '#!/bin/sh\nexec /app/skills/google-workspace/gws-account "$@"\n' > /usr/local/bin/gws-account && \
    chmod +x /usr/local/bin/gws-account

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

# Drop setuid-root from the binaries Debian ships (mount, su, passwd, ...). The
# agent runs unprivileged and needs none of them.
RUN find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true

USER node
WORKDIR /workspace/group

# Only applies to a bare `docker run` — the host spawn overrides ENTRYPOINT and
# passes --init instead (see hardeningArgs in src/container-runner.ts).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# ---- Provenance labels -------------------------------------------------------
# LAST on purpose. An ARG invalidates every layer below it, so declaring these
# up with the other build-args would make an otherwise-cached rebuild redo
# `bun install` and the pnpm global CLIs on every existing install, for two
# pieces of metadata. Labels have no filesystem effect, so they cost nothing here.
#
# Which lockfile the baked /app/node_modules came from: /app/src is mounted from
# the host checkout at every spawn, so an image and a checkout whose lockfiles
# disagree fail as a missing module inside a `--rm` container with no logs.
# container/pull.sh checks this before retagging. build.sh passes it; a bare
# `docker build` leaves it empty, which the pull path treats as unverifiable.
#
# image-source defaults to `local` so anything built from this file is honest
# unless its builder says otherwise — the retag cannot forge it after the fact.
ARG AGENT_RUNNER_LOCK_SHA256=
LABEL dev.nanoclaw.agent-runner-lock-sha256="${AGENT_RUNNER_LOCK_SHA256}"
ARG IMAGE_SOURCE=local
LABEL dev.nanoclaw.image-source="${IMAGE_SOURCE}"

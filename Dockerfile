# syntax=docker/dockerfile:1
#
# Agentric (agent-os) — container image for a Dockerfile-based PaaS (Dokku/Heroku-style).
#
# FULL runtime: the Node server, the React console, and the native tools every agent session shells
# out to (tmux, ttyd, claude, git — see src/edge/deps.ts). `AOS_UID_ISOLATION` stays OFF, so the app
# itself reverse-proxies /terminal/ (HTTP + the ttyd WebSocket upgrade) to a loopback ttyd and ONE
# published port is enough (`sharedTerminalProxy` / `sharedTerminalUpgrade` in src/server.ts).
#
# Three constraints shape this file; none are optional:
#
#  1. NOT root. The unattended lane launches claude with `--dangerously-skip-permissions`, which the
#     CLI refuses under uid 0. So the runtime user is `node` (uid 1000).
#  2. $HOME must be a real, writable, PERSISTENT directory. `terminal/claude-launch.sh` pre-seeds
#     `~/.claude.json` (in the home ROOT, temp-file + rename) to accept Claude Code's folder-trust
#     dialog — if that write fails, every session hangs on the trust prompt forever, and
#     `--dangerously-skip-permissions` does NOT dodge it. HOME also holds `.claude/.credentials.json`
#     (the only credential the TUI lane actually authenticates with) and `.claude/projects/*.jsonl`
#     (the transcripts the console's conversation view + cost reporting read back).
#  3. en_US.UTF-8 must EXIST. src/edge/session-backend.ts hardcodes `LANG: 'en_US.UTF-8'` into every
#     tmux pane; tmux string-matches it for "UTF-8" to decide UTF-8 mode. Without the generated
#     locale, glibc falls back to POSIX/ASCII and the claude TUI's box drawing mangles.
#
# No hostnames, IPs, emails or tokens belong here — deployment identity is all runtime config.

########################  build  ########################
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Root bundle has no runtime deps; typescript is a devDependency. --omit=optional skips
# @libsql/client (lazily imported only when memory.backend=libsql) and its native prebuilds.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --no-audit --no-fund

# The console is a separate npm project with its own lockfile.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY web ./web
RUN cd web && NODE_OPTIONS=--max-old-space-size=1536 npm run build

########################  runtime  ########################
FROM node:22-bookworm-slim AS runtime

ARG TTYD_VERSION=1.7.7
ARG GH_VERSION=2.97.0
ARG CLAUDE_VERSION=latest
ENV DEBIAN_FRONTEND=noninteractive

# tmux + git are declared deps; curl is used by the terminal/*.sh hooks; procps supplies `ps` for
# pane liveness; tini reaps the tmux/claude grandchildren that double-fork out of node's tree.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client tmux procps tini locales \
      jq ripgrep less unzip xz-utils \
 && sed -i 's/^# *\(en_US\.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
 && locale-gen \
 && locale -a | grep -qi '^en_US\.utf8$' \
 && rm -rf /var/lib/apt/lists/*

# ttyd: the official static release binary. Not reliably packaged in bookworm-slim, and the static
# build has no shared-library deps, so it drops into a glibc image unchanged and pins an exact version.
RUN curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
 && chmod 0755 /usr/local/bin/ttyd \
 && ttyd --version

# gh: agents do GitHub work through it (the per-member GitHub token is injected into their shell).
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      | tar -xz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh_* \
 && gh --version

# The agent runtime each session launches. Installed under /opt — NOT under HOME, which is mounted
# over at runtime and would hide it — and owned by `node` so an in-place upgrade works.
ENV NPM_CONFIG_PREFIX=/opt/npm-global
ENV PATH=/opt/npm-global/bin:$PATH
RUN mkdir -p /opt/npm-global \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && chown -R node:node /opt/npm-global \
 && claude --version

WORKDIR /app

# Keep the step even though the root package has no runtime deps today, so a future one is honoured.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force

# baseDir is dist/.. = /app, so terminal/, config/, public/, web/dist/ and package.json
# (read by src/version.ts) all have to land here.
COPY --from=build /app/dist     ./dist
COPY --from=build /app/web/dist ./web/dist
COPY terminal ./terminal
COPY config   ./config
COPY public   ./public
COPY bin      ./bin
COPY scripts/install-deps.sh ./scripts/install-deps.sh
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && ln -sf /app/bin/agent-os /usr/local/bin/agent-os

ENV NODE_ENV=production \
    HOME=/home/node \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    PORT=3010 \
    TTYD_PORT=3011 \
    AGENT_OS_HOME=/data \
    DISABLE_AUTOUPDATER=1

# Both /data and /home/node are bind-mounted at runtime; create and chown them so the mount targets
# exist and an unmounted run still works. Ownership by uid 1000 is what makes constraint 2 hold.
RUN mkdir -p /data /home/node/.claude \
 && chown -R node:node /data /home/node /app

USER node
EXPOSE 3010

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/cli.js", "serve"]

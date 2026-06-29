# Phase A deploy — the session launcher (A1)

The launcher is the one privileged component (`docs/phase-a-scope.md`). It runs as root and lets the
unprivileged app run each member's sessions as their own (DynamicUser) uid, over a group-gated unix
socket.

## Install (A1)

```bash
# 1. group the app user can use to reach the launcher socket
sudo groupadd -f aos
sudo usermod -aG aos vikas          # the agent-os service user

# 2. build, then install + start the launcher unit
npm run build
sudo install -m 644 deploy/aos-launcher.service /etc/systemd/system/aos-launcher.service
sudo systemctl daemon-reload
sudo systemctl enable --now aos-launcher.service
sudo systemctl status aos-launcher.service        # should be active; socket at /run/aos/launcher.sock

# 3. restart the app so its process picks up the new group membership
sudo systemctl restart agent-os.service
```

Verify the app can reach it (as the app user, once in group `aos`):

```bash
# ping over the socket
node -e 'const {LauncherClient}=require("./dist/edge/launcher");new LauncherClient("/run/aos/launcher.sock").ping().then(r=>console.log(r))'
```

## What A1 does / doesn't do yet

- **A1 (this):** the launcher daemon + client + protocol. `ensure_member` brings up a per-member
  DynamicUser holder (`aos-member-<m>.service`, home `/var/lib/aos/<m>`, slice `aos-<m>.slice`) and
  returns its live uid; `start_session` runs a session as that uid; `ttyd_up`/`stop`/`release`.
- **Not wired into the app yet** — `terminal.ts` still spawns tmux directly. Routing the app through
  the launcher (behind `AOS_UID_ISOLATION=1`) is milestone 2.
- **No credential seeding yet** — that's A3 (`seed-claude`, shared company `~/.claude`). Until then a
  member's home has no `~/.claude`, so real claude sessions won't authenticate; A1 is verified with a
  plain command.

## Enabling per-member isolation (milestones 2 + 3)

A1 above only installs the launcher. To actually route sessions through it, set the flag and point
nginx's `/terminal/` at the app (which now reverse-proxies to each member's own ttyd):

```bash
# 1. turn the flag on for the app service (and the launcher socket if non-default)
sudo systemctl edit agent-os.service     # add:  [Service]  Environment=AOS_UID_ISOLATION=1
# 2. the member uids must be able to READ/EXECUTE the runner scripts + memory MCP. Make the install
#    dir group-readable by `aos` (or relocate runtime assets to a world-readable path):
sudo chgrp -R aos /home/agent-os/tools/agent-os && sudo chmod -R g+rX /home/agent-os/tools/agent-os
sudo chmod o+x /home/agent-os            # member uids must traverse to reach the repo
sudo systemctl restart agent-os.service aos-launcher.service
```

nginx — flag ON (the app fronts the terminal and does the authz itself, so no `auth_request`):

```nginx
location /terminal/ {
    proxy_pass http://127.0.0.1:3010;          # the agent-os app (NOT ttyd) — it proxies per-member
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;     # ttyd is a websocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;       # the app resolves the member + checks attach authz
}
```

(Flag OFF keeps the original `location /terminal/` → ttyd port with the 0b `auth_request` — unchanged.)

### Shared company Claude credentials (A3)

The launcher seeds each member's `~/.claude` from a root-only template (default `/etc/aos/claude`,
overridable with `--claude-template=`). Populate it once from a working Claude Code login:

```bash
sudo mkdir -p /etc/aos/claude && sudo chmod 700 /etc/aos/claude
# copy the company login (prefer an API-key-based config over a subscription OAuth login — many
# concurrent member uids sharing one OAuth refresh token can fight on rotation):
sudo cp ~/.claude/.credentials.json /etc/aos/claude/   # and/or settings.json with an apiKeyHelper
sudo chmod 600 /etc/aos/claude/*
```

Each member's home gets its own copy (uid-owned, 0600) → per-member transcript privacy, one shared
Anthropic identity/bill. Per-session `.mcp.json`/company files are written into the member home too.

### Flag-on is functionally complete — what's left is deployment + verification
Core code is done (spawn as member uid · seeded `~/.claude` · per-session connectors · per-member
agent working dir · per-member ttyd via the app proxy). Before it's usable end to end:
- **Install `claude` member-reachable:** it must be on the session `PATH` — installed globally
  (`/usr/local/bin`) or alongside the app's node (the flag-on PATH includes that node's dir). A login
  confined to `vikas`'s home won't resolve for member uids.
- **Real e2e:** run a browser + claude session on the installed stack (verified here against mock
  ttyd + real systemd, but not a live browser+claude run).
- **Precise liveness:** the app can't poll uid-private sockets → launcher sessions flip to idle via
  `/api/ended`/`/api/report` rather than tmux polling (a known, minor gap).

Tunables (A5): per-member slice caps via the launcher `--slice-memory-max` / `--slice-cpu-weight` /
`--slice-tasks-max` (defaults 2G / 100 / 512); idle reclaim window via `AOS_IDLE_GRACE_MS` on the app
(default 15m) — a member's uid + ttyd are freed after that long with no running session (their home /
creds / agent working copies persist on disk).

## Uninstall / cleanup

```bash
sudo systemctl disable --now aos-launcher.service
sudo rm /etc/systemd/system/aos-launcher.service
# stop any member holders + remove homes (DESTRUCTIVE — removes per-member state):
for u in $(systemctl list-units 'aos-member-*' 'aos-ttyd-*' --no-legend --plain | awk '{print $1}'); do sudo systemctl stop "$u"; done
sudo systemctl reset-failed 'aos-member-*' 'aos-ttyd-*' 2>/dev/null || true
sudo rm -rf /var/lib/aos /run/aos
sudo systemctl daemon-reload
```

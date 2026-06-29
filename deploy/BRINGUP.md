# Flag-on bring-up checklist — per-member isolation (Phase A)

Turn `AOS_UID_ISOLATION=1` on for a live instance, step by step, **verifying each step before the next**.
Everything is reversible by flipping the flag back (see Rollback) — flag-off is byte-for-byte today's
behavior, so you can stop at any point without breaking the running console.

Run as a user with `sudo`. `<REPO>` = `/home/agent-os/tools/agent-os`. The app service is `agent-os.service`
(`User=vikas`), its node is the one in that unit's `ExecStart` (here
`/home/agent-os/.nvm/versions/node/v22.22.0/bin/node`). Members' Unix accounts are **auto-created on demand**
(systemd DynamicUser) — there is no `useradd` step.

---

## 0. Preconditions
- [ ] On a git checkout you can rebuild; the console currently works flag-off.
- [ ] You can afford a brief `agent-os.service` restart (drops live terminal attachments; sessions survive).

```bash
cd /home/agent-os/tools/agent-os
git status --short          # know what's uncommitted
systemctl is-active agent-os.service
```

## 1. Build
```bash
npm run build && (cd web && npm run build)
```
- [ ] Both succeed (no TS errors).

## 2. Group + app membership
The launcher socket is group-gated (`aos`); the app user must be in that group.
```bash
sudo groupadd -f aos
sudo usermod -aG aos vikas
id vikas | tr ',' '\n' | grep -q '(aos)' && echo "vikas in aos ✓"
```
- [ ] `vikas in aos ✓`. (The running service only picks this up after the restart in step 6.)

## 3. Make the runtime assets reachable by member uids
A flag-on session runs as the member's uid and must read the runner scripts + memory MCP, and exec
`node`/`claude`. The agent SOURCE dirs do **not** need this (the launcher copies them as root).
```bash
# repo readable + traversable for the aos group
sudo chgrp -R aos /home/agent-os/tools/agent-os
sudo chmod -R g+rX /home/agent-os/tools/agent-os
sudo chmod o+x /home/agent-os                      # member uids must traverse the home to reach the repo/node
# node + claude reachable (node is in the service's node dir; install claude alongside it or in /usr/local/bin)
sudo chmod -R a+rX /home/agent-os/.nvm/versions/node/v22.22.0
```
Verify a low-privilege account can resolve **both** `node` and `claude` on the session PATH:
```bash
NODEDIR=/home/agent-os/.nvm/versions/node/v22.22.0/bin
sudo -u nobody env -i PATH="$NODEDIR:/usr/local/bin:/usr/bin:/bin" HOME=/tmp \
  bash -c 'command -v node && command -v claude && node --version'
```
- [ ] Prints a `node` path, a `claude` path, and a version. **If `claude` is missing**, install it so it
  lands in `$NODEDIR` (`npm i -g @anthropic-ai/claude-code` using that node) or in `/usr/local/bin`, then
  re-run. (If `node` is missing, the home/nvm perms above weren't applied.)

## 4. Company Claude credentials template
The launcher seeds each member's `~/.claude` from this root-only dir (once per member).
```bash
sudo mkdir -p /etc/aos/claude && sudo chmod 700 /etc/aos/claude
sudo cp ~/.claude/.credentials.json /etc/aos/claude/      # prefer an API-key config over an OAuth login
sudo cp ~/.claude/.claude.json      /etc/aos/claude/ 2>/dev/null || true
sudo chmod 600 /etc/aos/claude/*
sudo ls -la /etc/aos/claude
```
- [ ] `.credentials.json` present, `0600`. (Shared OAuth logins can fight on token refresh across many
  concurrent members — an API-key-based config is the robust choice.)

## 5. Install + start the launcher (the one privileged unit)
```bash
sudo install -m 644 deploy/aos-launcher.service /etc/systemd/system/aos-launcher.service
sudo systemctl daemon-reload
sudo systemctl enable --now aos-launcher.service
systemctl is-active aos-launcher.service
ls -l /run/aos/launcher.sock        # expect srw-rw---- root aos
```
- [ ] Unit `active`; socket exists, mode `0660`, group `aos`.

Mechanism check (as the app user, with the aos group):
```bash
sudo -u vikas -g aos node -e 'import("/home/agent-os/tools/agent-os/dist/edge/launcher.js").then(m=>new m.LauncherClient("/run/aos/launcher.sock").ping().then(r=>{console.log(r);process.exit(0)}))'
```
- [ ] Prints `{ ok: true }` (the app user can reach the launcher).

## 6. Flip the flag on the app + restart
```bash
sudo systemctl edit agent-os.service     # add the three lines, save:
# [Service]
# Environment=AOS_UID_ISOLATION=1
sudo systemctl restart agent-os.service
systemctl show agent-os.service -p Environment | grep AOS_UID_ISOLATION && echo "flag set ✓"
sudo -u vikas id | grep -q aos && echo "service user has aos group ✓"
```
- [ ] Flag set; the (restarted) service user now has the `aos` group; console still loads.

## 7. Point nginx /terminal/ at the app
Under flag-on the **app** fronts the terminal (it reverse-proxies to each member's ttyd and does the
authz itself — no `auth_request`). Replace the `location /terminal/` block:
```nginx
location /terminal/ {
    proxy_pass http://127.0.0.1:3010;          # the app (NOT ttyd)
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;     # ttyd is a websocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
```
- [ ] `nginx -t` ok; reloaded.

## 8. Smoke test (a real session, end to end)
Provision a member if needed, then drive a session from the browser as that member (or as the owner —
the owner gets their own space too):
```bash
node dist/cli.js invite teammate@yourco.com member   # prints a magic link (skip if using the owner)
```
In the browser: log in → run an agent → open its terminal. Then verify on the host:
```bash
# a member holder + session scope should be running as a NON-vikas dynamic uid
systemctl list-units 'aos-member-*' --no-legend --plain
PID=$(systemctl show -p MainPID --value aos-member-*.service | head -1); U=$(awk '/^Uid:/{print $2}' /proc/$PID/status)
echo "member uid=$U (vikas=$(id -u vikas))"
ps -o pid,uid,args -U "$U" | grep -E 'tmux|claude'                 # session runs as that uid
sudo -u vikas ls /var/lib/aos/*/.claude 2>&1 | grep -q denied && echo "cross-uid read DENIED ✓"
systemctl show aos-member-*.slice -p MemoryMax -p TasksMax | head  # caps applied
```
- [ ] Terminal renders in the browser and you can type.
- [ ] Session processes run as a dynamic uid ≠ `vikas`; `claude` is among them (authenticated).
- [ ] `vikas` is **denied** reading a member's `~/.claude`; the slice shows the caps.
- [ ] (Optional, ~15m later) an idle member's `aos-member-*`/`aos-ttyd-*` units are gone (idle GC).

## 9. Rollback (instant, safe)
```bash
sudo systemctl revert agent-os.service          # remove the AOS_UID_ISOLATION drop-in
# restore the original nginx /terminal/ block (→ ttyd:3011 + the 0b auth_request), then:
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart agent-os.service
# optional: stop the launcher + reclaim member homes (DESTRUCTIVE for per-member state):
#   sudo systemctl disable --now aos-launcher.service
#   for u in $(systemctl list-units 'aos-member-*' 'aos-ttyd-*' --no-legend --plain | awk '{print $1}'); do sudo systemctl stop "$u"; done
#   sudo rm -rf /var/lib/aos /run/aos
```
Back to single-uid (flag-off) behavior immediately.

## 10. Known gaps to keep in mind
- **Precise liveness:** the app can't poll uid-private sockets, so launcher sessions flip to idle from
  the agent's own `/api/ended` / `/api/report` signals, not tmux polling. A session whose tmux is killed
  out-of-band may read "running" until the next signal.
- **Idle GC across app restarts:** the reaper only knows spaces this app process started; holders from
  before a restart aren't auto-reclaimed (cleaned on the next deploy, or stop them by hand).
- **Tunables:** launcher `--slice-memory-max|--slice-cpu-weight|--slice-tasks-max` (defaults 2G/100/512);
  app `AOS_IDLE_GRACE_MS` (default 15m).

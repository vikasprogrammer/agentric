# Tenant box-to-box migration runbook

How to move a **process-per-tenant** Agent OS deployment (one `agent-os serve` process = one tenant)
from one Linux box to another with **minimal downtime** (~2–4 min) and a clean rollback. Written from
the globex move off the shared **jump-server** onto a dedicated box (2026-07-21). Substitute your own
old/new hosts, user, tenant slug, port, and public hostname.

> **Why box-to-box and not a version bump:** keep the migration **like-for-like** — deploy the *same
> commit* the old box runs so no DB migrations fire and behaviour is identical. Do the version upgrade
> as a *separate* step after the move is verified. Two risky changes at once is how you lose a Sunday.

Reference values used below (replace with yours):

| | old (source) | new (target) |
|---|---|---|
| host | `vikas@OLD_IP` | `ubuntu@NEW_IP` |
| install | `/home/agent-os/tools/agent-os` | `/home/ubuntu/tools/agent-os` |
| data home | `…/data` | `…/data` |
| unit | `agent-os-<tenant>.service` | same |
| ports | app `3012`, ttyd `3013` | same |
| public | `https://aos.example.net` | same (DNS repoints) |
| memory | AutoMem (`agentos_<tenant>` graph+collection) | replicated lean |

---

## 0. What actually has to move (scope it)

Only the **one tenant** moves. On a shared box, everything else (other tenants, other apps, monitoring)
stays put. The tenant's state is:

- **Data home** (`$AGENT_OS_HOME`) — the DB (`agent-os.db`, holds *all* tokens: Slack/Discord/GitHub,
  settings, members, sessions, memory mirror, KB, tasks, audit), **`secret.key`** (⚠ without it every
  vaulted secret fails to decrypt), `gh.env`, `agents/`, `skills/`, `kb/`, `policy/`, `artifacts/`,
  `task-attachments/`, `connectors/`, `audit/`.
- **The agent-os checkout + systemd unit + drop-ins.**
- **nginx vhost + TLS cert.**
- **AutoMem data** — the tenant's Qdrant collection + FalkorDB graph (if the memory backend is AutoMem).
- **⚠ Claude transcripts** — `~/.claude/projects/` (NOT in the data home; needed for session *resume*).
  Easy to forget; see §5.

---

## 1. Pre-flight (before any downtime)

1. **Access to the new box.** Get SSH in. If the old box can already reach the new one (jump host),
   install your key through it: `ssh old "ssh user@NEW_IP 'cat >> ~/.ssh/authorized_keys'" <<< "$PUBKEY"`.
   Set up a **new→old** key too (for rsync driven by the idle new box): generate on new, append to old's
   `authorized_keys` (may need `sudo tee` if that file is root-owned).
2. **Confirm the new box is bigger and dedicated.** `free -h`, `nproc`, `df -h /`.
3. **Decide the memory backend** — keep AutoMem (replicate + copy the graph/collection) or switch to
   built-in sqlite. Keeping AutoMem = byte-identical recall.
4. **Lower the DNS TTL** on the public hostname to ~60s **now**, so the eventual cutover propagates fast.
5. **Disable unattended auto-reboot on the new box** (it bit us — a kernel upgrade rebooted mid-setup):
   ```
   echo 'Unattended-Upgrade::Automatic-Reboot "false";' | sudo tee /etc/apt/apt.conf.d/99-no-auto-reboot
   sudo systemctl stop unattended-upgrades
   ```

---

## 2. Phase 1 — Prep (zero downtime, old box stays live)

Everything here is non-destructive; the old box keeps serving.

1. **Toolchain** on the new box: `sqlite3 ttyd nginx certbot python3-certbot-nginx build-essential`,
   Node via nvm at the **exact version the old box runs** (`node --version` there — match it), the
   `claude` CLI (`npm i -g @anthropic-ai/claude-code`, symlink into `~/.local/bin`), Docker + compose.
   Wait out the boot-time apt lock first (`fuser /var/lib/dpkg/lock-frontend`).
2. **Code, like-for-like.** The server's git remote is often a private fork the new box can't clone —
   just **rsync the checkout** (exclude `data/ node_modules/ dist/ web/node_modules/ web/dist/`), then
   `npm ci && npm run build` + `(cd web && npm ci && npm run build)`. Confirm `git rev-parse HEAD` matches.
3. **Claude auth (skip the manual `/login`).** Copy `~/.claude.json` + `~/.claude/.credentials.json`
   from the old user to the new user. Verify `claudeAiOauth` scopes include `user:inference`.
4. **AutoMem — lean stack.** Copy the buildable automem source + real `.env`. Write a trimmed
   `docker-compose.yml` with only `falkordb` + `qdrant` + the **one** tenant service (`FALKORDB_GRAPH`/
   `QDRANT_COLLECTION` = `agentos_<tenant>`, host port `8007→8001`). `docker compose up -d --build`,
   confirm `curl :8007/health` shows `falkordb/qdrant connected`, `memory_count:0`.
5. **Systemd unit + drop-ins** (see §7 for the correct hardening — the `ProtectHome` trap).
6. **nginx vhost + TLS.** Copy the vhost. Stage the old cert
   (`tar czf … /etc/letsencrypt/{archive,live,renewal}/<host>* options-ssl-nginx.conf ssl-dhparams.pem`),
   extract on the new box → valid TLS immediately (certs aren't IP-bound). `nginx -t`, enable the site,
   `rm` the `default` site.
7. **Bulk data rsync** (old→new, old still live): `rsync -a --no-o --no-g` the data home, excluding
   `tmux.sock tmp/ *.db-wal *.db-shm`. This pre-seeds the big dirs; the DB gets a consistent final sync
   at cutover.
8. **Boot smoke-test** against a **throwaway empty home on a spare port** (proves the binary boots +
   reports the right version without opening the tenant's Slack socket or touching live data):
   `AGENT_OS_HOME=/tmp/boottest PORT=3099 node dist/cli.js serve`.
9. **Validate the firewall** allows inbound 80/443 to the new box by hitting it by IP before DNS moves
   (`curl -k -H 'Host: <host>' https://NEW_IP/` — expect TLS handshake + 502 while the app is off).

---

## 3. Phase 2 — Cutover (downtime ≈ 2–4 min)

⚠ **Slack/Discord are Socket Mode with shared tokens** — the socket can only live in one place, so the
old app must be **stopped** before the new one starts, or the bot double-processes.

1. **Stop + freeze old** — `sudo systemctl stop agent-os-<tenant>`; confirm nothing holds the DB
   (`fuser data/agent-os.db`); checkpoint: `node -e "new (require('node:sqlite').DatabaseSync)('agent-os.db').prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()"`.
2. **Final data rsync** (now consistent): same rsync as §2.7 but `--delete`, and delete stale
   `*.db-wal/-shm` on the target first. Verify `PRAGMA integrity_check` = ok and row counts look sane.
3. **Migrate AutoMem data** (small — seconds):
   - **Qdrant:** `POST :6333/collections/agentos_<tenant>/snapshots` on old → download → on new
     `POST …/snapshots/upload?priority=snapshot -F snapshot=@file`.
   - **FalkorDB:** dump+restore the single graph key via the automem container's python-redis:
     `r.dump('agentos_<tenant>')` → base64 → transfer → `r.delete(...)`+`r.restore(...)` on new.
   - Verify new `:8007/health` `memory_count` and an authed `/recall` returns hits.
4. **Start new** — `sudo systemctl enable --now agent-os-<tenant>`; verify `/health` (version + right
   tenant), API routes are **401 not 404**, web `/` = 200, HTTPS = 200, and the **Slack socket** is up
   (an outbound `:443` from the node PID resolving to `wss-primary.slack.com`:
   `ss -tnp | grep pid=<MainPID> | grep :443`).
5. **Repoint DNS** A record → NEW_IP. (Optional zero-blip: point the old nginx vhost at the new box so
   stragglers on the old IP are proxied through during propagation.)
6. **Reissue the TLS cert fresh** on the new box (do **not** rely on the copied renewal config — its
   dry-run can hang): `sudo certbot certonly --nginx -d <host> --non-interactive --agree-tos -m <email>
   --force-renewal`, reload nginx, confirm `certbot.timer` is active.

---

## 4. Phase 3 — Path-porting (⚠ the step everyone forgets)

The data home carries **absolute old-home paths baked into files**. New sessions recompute paths and
work; but **resume**, **MCP**, and **gate-hook protections** replay the baked absolutes and break/degrade.
Rewrite `/home/OLDUSER/` → `/home/NEWUSER/` in the agent-os-generated files (NOT node_modules or
checked-out repos):

```bash
cd $DATA_HOME
# per-session files: session-*.env (AGENT_DIR/MCP_CONFIG/HOOK/COMPANY_FILE), *.mcp.json, *.company.md
for f in $(grep -rlI '/home/OLDUSER' connectors/); do sed -i 's#/home/OLDUSER/#/home/NEWUSER/#g' "$f"; done
# agent .claude configs + CLAUDE.md + aos-settings.json (gate-hook permission globs!) — exclude repos/node_modules
find agents -type f \( -path '*/.claude/*' -o -name 'CLAUDE.md' -o -name 'agent.json' \) \
  ! -path '*/node_modules/*' ! -path '*/repos/*' -print0 | xargs -0 grep -lI '/home/OLDUSER' \
  | while read f; do sed -i 's#/home/OLDUSER/#/home/NEWUSER/#g' "$f"; done
```

See §6 bugs #1/#2 — these baked paths are the underlying defect.

---

## 5. Phase 3 — Claude transcripts (for session resume)

Transcripts live **outside** the data home in `~/.claude/projects/<munged-cwd>/<claude_session_id>.jsonl`,
where `<munged-cwd>` is the absolute agent-dir with `/`→`-`. They must be copied AND re-munged so the new
cwd matches:

```bash
rsync -a vikas@OLD_IP:/home/agent-os/.claude/projects/ ~/stage-cp/
cd ~/stage-cp
for d in */; do d="${d%/}"
  case "$d" in -home-OLDUSER-*) t="${d/-home-OLDUSER-/-home-NEWUSER-}";; *) t="$d";; esac
  mkdir -p ~/.claude/projects/"$t"
  rsync -a "./$d/" ~/.claude/projects/"$t/"     # ⚠ the ./ prefix: dir names start with '-' → rsync
done                                              #   would otherwise parse the source as CLI flags
rm -rf ~/stage-cp
```

Verify: for a stopped session, `session-<id>.env` has the new `AGENT_DIR` **and**
`~/.claude/projects/-home-NEWUSER-…-<agent>/<claude_session_id>.jsonl` exists.

---

## 6. Post-cutover cleanup & rollback

- **Old box safety:** `sudo systemctl disable agent-os-<tenant>` (stopped **and** disabled — else a
  reboot revives it and opens a *duplicate* Slack socket against the live tokens). Leave the data intact.
- **Old nginx/cert:** remove the old `aos` vhost + its certbot renewal entry so the old box's certbot
  stops failing to renew a domain that moved. (Do after the rollback window closes.)
- **Rollback:** flip DNS back + `systemctl enable --now agent-os-<tenant>` on the old box. Nothing on the
  old box was mutated, so rollback is instant. Keep the old box untouched for a few days.

## 7. Gotchas checklist

- **`ProtectHome=read-only` hangs every session on the trust dialog.** The launcher seeds
  `~/.claude.json` (home **root**) via temp+rename → needs the home *directory* writable, not just
  `~/.claude`. Match the shipped unit: **drop `ProtectHome`**, `ReadWritePaths=/home/<user>` + `/tmp`,
  `ReadOnlyPaths=/home/<user>/.ssh`, keep `ProtectSystem=strict`.
- **`secret.key` is load-bearing** — copy it (perms `600`) or the whole vault fails closed.
- **Match Node major exactly** (`node:sqlite` needs 22+); point the unit `PATH`/`ExecStart` at the nvm binary.
- **rsync source dirs beginning with `-`** are read as flags — prefix `./`.
- **Concurrency cap:** the derived default scales with RAM (`max(3, floor(GB/1.5))`), so a big box
  auto-derives a high cap. Pin `AOS_MAX_CONCURRENT_SESSIONS` conservatively at first, tune up later.
- **Verify, don't assume:** memory `.env` token length, `integrity_check`, Slack `:443` socket, HTTPS by
  IP pre-DNS, 401-not-404 on `/api/*`.

## 8. Bugs this runbook is a workaround for (fix upstream)

1. **🔴 `aos-settings.json` gate-hook permission globs are absolute** → protections silently no-op after a
   home move. Derive from the live home / realpath in the gate hook.
2. **🟠 Persisted `session-*.env` / `.mcp.json` bake absolute `AGENT_DIR`/paths** → stopped sessions
   un-resumable after any home move. Persist home-relative; reconstruct at resume.
3. **🟠 Claude transcripts live outside the data home** → "copy the data home" silently drops resume
   history. Document, and ideally relocate transcripts under the home or ship an export/import helper.

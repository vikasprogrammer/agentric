# Phase A — implementation scope (per-member uid substrate)

Turns the per-member privacy from **app-level intent** (Phase 0) into an **OS-enforced** boundary:
each member's sessions run as their own Unix uid, with their own `$HOME`/`~/.claude`, tmux socket,
and ttyd — so one member's shell physically cannot read another's tokens or transcripts. Builds on
the launcher trust-root described in `docs/per-user-isolation-plan.md`; this doc is the build spec.

## Decisions locked (2026-06-16, with Vikas)

- **Account model = systemd `DynamicUser`** — transient uids systemd allocates on demand; no managed
  `useradd` pool. Per-member state persists via `StateDirectory`.
- **Claude identity = one shared company Anthropic account** — the same credentials are copied into
  every member's home. Per-member *file/transcript* privacy is preserved (separate homes); the
  Anthropic *identity and bill* are shared.
- Environment confirmed: systemd 256 (`systemd-run --uid`, scopes, slices, DynamicUser), ttyd 1.7.7,
  tmux, `setpriv`/`runuser` present. `apparmor_restrict_unprivileged_userns=1` → Phase B (rootless
  containers) stays deferred; uid-per-member is the substrate.

## Model: per-member "holder" service + per-session scopes

A naive "one DynamicUser unit per session" breaks: two concurrent sessions of the **same** member
get **different** transient uids and fight over that member's home (`StateDirectory`, mode 0700). So:

- **`aos-member-<member>.service`** (transient, via `systemd-run`) — `DynamicUser=yes`,
  `Slice=aos-<member>.slice`, runs a trivial idle holder (`/usr/bin/sleep infinity`). Its only job is
  to **hold one stable dynamic uid while the member is active**. The launcher reads that uid from
  `systemctl show -p MainPID` → `/proc/<pid>/status`.
- 🔴 **The launcher owns the directories — NOT systemd `StateDirectory`/`RuntimeDirectory`.** This was
  verified the hard way: with `DynamicUser`, those managed dirs are **unit-private**, so a sibling
  session *scope* (even at the same uid) gets `Permission denied` on the holder's `RuntimeDirectory`
  socket. Instead the launcher (root) creates `/var/lib/aos/<member>` (home) and `/run/aos/<member>`
  (tmux socket) as **plain dirs**, `chown`s them to the holder's live uid at **0700** (re-chown only
  when the uid drifts across a holder restart), so every one of that member's session scopes can share
  them and no other uid — including the app's `vikas` — can read them. Verified: `vikas` gets `EACCES`
  on the member home.
- **Sessions and the member's ttyd** run as that uid via
  `systemd-run --uid=<uid> --slice=aos-<member>.slice --scope --setenv=HOME=/var/lib/aos/<member> …`.
  All of a member's sessions share their uid/home/`~/.claude`/tmux socket; different members are
  different uids → mutually unreadable.
- **uid recycling:** the home persists on disk across idle. `release_member` **neutralizes** it
  (`chown root:root`) when the holder stops, so a later recycle of that dynamic uid to another member
  can't read it; the next `ensure_member` re-chowns it to the new live uid. (A3's `seed-claude` will
  populate `~/.claude` inside this launcher-owned home.)

## A1 — the launcher (the one privileged component)

`aos-launcher.service` runs as root (it must `chown` seeded creds and signal foreign uids); the app
(`vikas`, in group `aos`) talks to it over `/run/aos/launcher.sock` (`0660`, group `aos`). It exposes
exactly these verbs and **nothing else**:

```
ensure_member(member)                              -> uid      # start holder if down; return live uid
start_session(member, session_id, sock, env, cmd)  -> ok       # systemd-run scope as member uid
stop_session(member, sock, tmux_name)              -> ok
ttyd_up(member, port, sock)                        -> ok
ttyd_down(port)                                    -> ok
release_member(member)                             -> ok       # stop holder when idle (GC)
```

Security surface — keep it tiny, no shell interpolation (exec argv arrays only), audited:
- `member` must be a known member id (validated against a member-list the app maintains at
  `/run/aos/members`, or via a read-only query the launcher trusts).
- `sock` must resolve under `/run/aos/<member>/`.
- `cmd` ∈ { the launcher script `claude-launch.sh` / `agent-runner.sh`, `ttyd` } only.
- `env` keys allowlisted: `AOS_URL`, `SESSION`, `AGENT`, `TASK_B64`, `AOS_SECRET`, `HOME`, `PATH`,
  `HEADLESS`, `LOG_DIR`, `AGENT_DIR`, `HOOK`, `MCP_CONFIG`, `COMPANY_FILE`.

Everything else — policy, gate, approvals, DB, audit — stays in the unprivileged app. The loopback
gate is unchanged (works from any uid; carries the 0d `X-AOS-Secret`).

**Files:** new `src/edge/launcher.ts` (client over the socket) + a standalone launcher binary/unit +
`/usr/local/lib/aos/seed-claude`. `terminal.ts` `launchTmux`/`killTmux` call the launcher instead of
spawning `tmux` directly.

## A2 — member → space

No uid column needed (systemd allocates). The member id is the key: `aos-member@<member>.service`
+ `/var/lib/aos/<member>`. Provisioning is implicit on first use (`ensure_member`). **Automations:**
a fired session runs in its `created_by` member's space; a system/no-owner automation gets a
dedicated `aos-automations` space. **Files:** `edge/automations.ts` (resolve owner), `terminal.ts`
(pass member to the launcher).

## A3 — home + shared Claude credentials

- **Template:** the company Anthropic creds live root-only at `/etc/aos/claude/` (e.g.
  `.credentials.json` / `.claude.json`). Admin populates once (runbook).
- **Seed:** `seed-claude` (root, via `+ExecStartPre`) copies them into `/var/lib/aos/<member>/.claude/`
  on holder start, `0600`, chowned to the live uid.
- `terminal/claude-launch.sh` already respects `HOME`; the scope sets `HOME=/var/lib/aos/<member>`.
- The app's own unit drops `ReadWritePaths=/home/agent-os/.claude` (sessions no longer use it). Per-session
  materialised files (`.mcp.json`, company.md, transcript) move under the member's runtime/home dir,
  still written `0600` (Phase 0a), now also uid-isolated.
- ⚠️ **Ops sub-decision:** a shared *subscription* login driven by many concurrent uids may hit
  Anthropic seat/concurrency limits. Strongly consider a **company API key with a budget cap** as the
  shared credential instead of a copied subscription login. (Needs a follow-up call — see Risks.)

## A4 — per-uid tmux socket + per-uid ttyd + routing

- **Socket per member:** `/run/aos/<member>/tmux.sock` (was one global socket in `home.ts`).
  `TerminalManager` resolves the socket per spawning member; `launchTmux`/`killTmux`/`aliveTmuxNames`
  operate on it (via the launcher for cross-uid ops).
- **ttyd per member:** one ttyd as the member's uid on an allocated loopback port; the app tracks
  member→port, lazy-starts on first attach, reaps on idle.
- **nginx:** route `/terminal/<member>/` → that member's ttyd port (a routing map or per-member
  location). The 0b attach-authz already enforces `canViewSession`; extend it to confirm the
  `<member>` path segment matches the cookie's member. `web/src/App.tsx` terminal `src` becomes
  `/terminal/<member>/?arg=…`.

**Files:** `home.ts`, `terminal.ts`, `server.ts` (`launchTtyd` → per-uid via launcher, port alloc,
lifecycle), nginx config, `web/src/App.tsx`.

## A5 — resource slices + cross-uid lifecycle

- `aos-<member>.slice` with `CPUWeight` / `MemoryMax` / `TasksMax` (configurable) so one member can't
  starve the box (today `LimitNPROC`/`NOFILE` are global to the app).
- `stopSession`/`deleteSession`/`killTmux` route through the launcher (signaling a foreign uid needs
  privilege). `removeSessionFiles` runs as/for the owner uid.
- **Idle GC:** when a member has no running session for N minutes, `release_member` stops the holder
  (frees the uid + ttyd). Homes persist (StateDirectory).

## Sequencing & milestones (feature-flagged: `AOS_UID_ISOLATION=1`)

1. ✅ **Launcher** unit + client + socket protocol (`src/edge/launcher.ts`, `agent-os launcher`
   subcommand, `deploy/aos-launcher.service`). Verified privileged: `ensure_member` allocates a
   DynamicUser uid, `start_session` runs a tmux session as that uid in the member's slice, `vikas` is
   denied the member home (`EACCES`), `release_member` neutralizes it. App not wired in yet (next).
2. ✅ Route session spawn/kill through the launcher; per-member tmux socket. A `SessionBackend` seam
   (`src/edge/session-backend.ts`) with `LocalSessionBackend` (flag off — byte-for-byte today) and
   `LauncherSessionBackend` (flag on — `systemd-run` per-member uid). `TerminalManager` builds
   `{env, argv}` once and dispatches to the backend; selected by `AOS_UID_ISOLATION` at construction.
   Verified: flag-off real spawn (env intact, liveness, kill); flag-on full chain
   (client→socket→daemon→session as a DynamicUser uid). **Deferred to milestone 3 under flag-on:**
   (a) per-session `.mcp.json`/company files are still written in the app's home (member uid can't
   read them → connectors/company silently absent until a file-handoff lands); (b) precise liveness
   (the backend returns `null` → sessions flip to idle via `/api/ended`+`/api/report`, not polling);
   (c) ttyd is still the single shared instance — browser attach to a per-member session isn't wired.
3. ✅ Per-member ttyd + routing + the `web` `src` change. The launcher's `ttyd_up` runs a ttyd AS the
   member uid on an allocated loopback port (`LauncherSessionBackend` allocates 7700+ per space); the
   app **reverse-proxies** `/terminal/<space>/` (HTTP + WebSocket) to that port with inline authz
   (`terminalProxy`/`terminalUpgrade` in `server.ts`, gated by `proxyPortFor`), so no per-member nginx
   config is needed — nginx just forwards `/terminal/` to the app under the flag. A `GET
   /api/sessions/:id/attach` endpoint ensures the member ttyd and returns the iframe URL; the web
   `TerminalFrame` fetches it (works for both flags). Verified: proxy HTTP 200 + headers, 401/403
   authz, **WebSocket upgrade proxied** (mock ttyd); launcher `ttyd_up` runs ttyd as the member uid
   serving HTTP 200 (privileged). **Remaining for usable flag-on:** A3 creds + the `.mcp.json`/company
   file-handoff into the member home (connectors), and a real browser e2e on an installed stack.
4. ✅ Shared-creds seeding (`seedClaude` — copies the root-only `/etc/aos/claude` template into each
   member's `~/.claude`, uid-owned 0600/0700, once) + **session file-handoff** (the launcher writes the
   `.mcp.json`/company into the member home via `start_session` `files` and sets MCP_CONFIG/
   COMPANY_FILE/LOG_DIR). `TerminalManager` builds the contents once (`buildMcpConfigJson`/
   `buildCompanyMd`); flag-off still materialises into the app dir + persists the resurrect `.env`.
   Verified (privileged): creds seeded uid-owned, session files member-readable, `vikas` denied,
   env wired. **Remaining blocker for real claude under flag-on:** the agent working dir — claude does
   `cd $AGENT_DIR` and writes `.claude/settings.json` there, but the shared agent folder is app-owned
   (member uid can't write). Needs a **per-member agent working copy** (copy-on-use into the member
   home) — the next milestone. Also: the session env needs `node`+`claude` on `PATH`, and the install
   dir must be group-readable by `aos` (see `deploy/README.md`).
5. ✅ Slices + idle GC + cross-uid cleanup. Per-member `aos-<m>.slice` is now **resource-capped**
   (`applySliceCaps` → `systemctl set-property --runtime`; defaults MemoryMax=2G/CPUWeight=100/
   TasksMax=512, configurable via `--slice-*` flags). **Idle GC**: `TerminalManager.reapIdleSpaces`
   runs each minute (started in `startServer`), and for each space the backend manages with no running
   session + none started within `AOS_IDLE_GRACE_MS` (default 15m) calls `backend.release` →
   `ttyd_down` + `release_member` (frees the uid/ttyd; the home/creds/agent copies persist). stop/delete
   already route through the launcher (M2). Verified: caps applied on the slice; GC releases idle/empty
   spaces, keeps running + recently-active ones.
6. ✅ **Per-member agent working dir.** claude `cd $AGENT_DIR` + writes `.claude/settings.json`/scratch;
   the shared agent folder is app-owned, so the launcher gives each member a WORKING COPY under their
   home (`syncAgentDir`: full copy on first use, then refresh CLAUDE.md + `.claude/skills` only — member
   claude state survives), chowned to the member uid, and overrides AGENT_DIR. Session `PATH` is seeded
   with the app's node dir + standard bins under the flag. Verified (privileged): copy uid-owned,
   member can write, `vikas` denied, refresh preserves member state.

**Phase A (A1–A5) is code-complete.** A flag-on session spawns as the member's uid, with seeded
`~/.claude`, per-session connectors, a writable per-member agent working dir, a per-member ttyd the
app reverse-proxies to, a resource-capped slice, and idle GC reclaiming uids/ttyds. What remains is
**deployment + a real e2e**, not core code: install the launcher unit, make the install dir
group-readable by `aos`, install `claude` somewhere member-PATH reachable, populate `/etc/aos/claude`,
flip the flag, point nginx `/terminal/` at the app — then run a real browser + claude session end to
end. The only known code-level gap is **precise liveness** (the app can't poll uid-private sockets, so
launcher sessions flip to idle via `/api/ended`+`/api/report`, not tmux polling).

Each milestone is independently testable; the flag lets you roll forward/back without reverting code.

## Risks / open sub-decisions

- **Shared subscription vs company API key** for the shared credential (recommend API key + cap). ←
  follow-up call before A3.
- **DynamicUser holder-service indirection** — the extra moving part vs a fixed pool (see top note).
- **ttyd-per-member memory** — N idle ttyds; mitigate with lazy-start-on-attach + idle reap.
- **nginx per-member routing** strategy (map vs generated locations) — pick before A4.
- **Idle GC timing** — too aggressive churns uids/creds re-seed; too lazy holds resources.

## Verification (throwaway instance on a spare port)

Create 2 members, spawn sessions as each, then assert:
- session processes run as **different** uids (`ps -o uid=`), neither equal to `vikas`;
- member A's shell gets `EACCES` reading `/var/lib/aos/<B>/.claude/.credentials.json` and B's
  session `.mcp.json`;
- tmux sockets are `0700` and uid-owned per member;
- the 0b attach-authz blocks cross-member attach (now also at the OS layer);
- `aos-<member>.slice` caps CPU/Mem (stress one member, confirm the other is unaffected);
- killing/deleting a session from the console reaps the foreign-uid processes via the launcher.

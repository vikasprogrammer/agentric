# Process-per-tenant on a Mac Mini over Tailscale

The chosen model for running a few isolated tenants on one box: **one OS process per tenant**, each
fully self-contained, fronted by `tailscale serve`. No reverse proxy, no wildcard DNS, no app changes.

This is the model Agent OS was built for — "distinct `AGENT_OS_HOME` + `PORT` = an isolated instance".
The in-process tenant registry (`src/tenant-registry.ts`) stays in the tree but is **dormant** here:
each process serves exactly one tenant at the apex host.

## Why this shape (and not subdomains / one process)

- **Tailscale MagicDNS gives one name per machine** (`your-box.tailnet.ts.net`) — no wildcard
  DNS, no `*.ts.net` TLS. So subdomain-per-tenant can't work without your own domain.
- **Tailscale serves HTTPS on three ports** — `443`, `8443`, `10000`. Mapping one tenant port to each
  makes every tenant a **separate origin** → clean per-tenant cookies, **zero app changes**. Hence the
  ≤3-tenant fit.
- Process-per-tenant keeps each tenant's settings, DB, audit, sockets and credentials in its own home —
  nothing leaks across the process boundary.

## One-time

```bash
npm run build && (cd web && npm run build)      # software
cp config/tenants.example.json config/tenants.json   # edit slugs/homes/ports/owners
```

## Run each tenant (its own process)

`scripts/run-tenant.sh <slug> <home> <port> [owner-email]` sets `AGENT_OS_HOME`, `AGENT_OS_TENANT`,
`AGENT_OS_OWNER_EMAIL`, `PORT`, `TTYD_PORT=PORT+1`, then `agent-os serve`. The home is created if
missing; the owner's one-time magic-link is printed to that process's console + `<home>/server.log`.

```bash
scripts/run-tenant.sh acme    ~/aos/acme    3010  you@acme.com
scripts/run-tenant.sh globex  ~/aos/globex  3020  you@globex.com
scripts/run-tenant.sh initech ~/aos/initech 3030  you@initech.com
```

Space ports by ≥2 (each process also binds `PORT+1` for its ttyd). Run them in three terminals/tabs,
or under launchd to survive reboots (template below).

## Publish over Tailscale

```bash
scripts/tailscale-serve.sh 3010 3020 3030
```

maps:

| Tenant URL | → local process |
|---|---|
| `https://your-box.tailnet.ts.net` | `127.0.0.1:3010` |
| `https://your-box.tailnet.ts.net:8443` | `127.0.0.1:3020` |
| `https://your-box.tailnet.ts.net:10000` | `127.0.0.1:3030` |

`tailscale serve` forwards `X-Forwarded-Proto: https` and the original `Host`, so the app's generated
invite/webhook links come out as the correct public `https://…` URLs. Undo with
`tailscale serve --https=<port> off`.

> Want **pretty subdomains** instead of ports (`acme.apps.example.com`)? Point a wildcard
> `*.apps.example.com` at this node's tailnet IP, set `"baseDomain": "apps.example.com"` in
> `config/agent-os.config.json`, and run a single process with the registry enabled — the subdomain
> routing already built handles it with no app changes. That's the path if you outgrow 3 tenants.

## Optional: launchd (persist across reboots)

One plist per tenant at `~/Library/LaunchAgents/com.agentos.<slug>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agentos.acme</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>~/Projects/agent-os/scripts/run-tenant.sh</string>
    <string>acme</string><string>~/aos/acme</string><string>3010</string><string>you@acme.com</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>~/aos/acme/server.log</string>
  <key>StandardErrorPath</key><string>~/aos/acme/server.log</string>
</dict></plist>
```

```bash
launchctl load  ~/Library/LaunchAgents/com.agentos.acme.plist     # start + enable at boot
launchctl unload ~/Library/LaunchAgents/com.agentos.acme.plist    # stop
```

Run `scripts/tailscale-serve.sh …` once (it persists with `--bg`).

## Verify

- `curl -s https://your-box.tailnet.ts.net/health` → `{"ok":true,"tenant":"acme"}`; the
  `:8443` / `:10000` URLs return their own tenant ids.
- Each home on disk is independent: `~/aos/globex/agent-os.db`, its own `tmux.sock`, `audit/`.
- Logging into one tenant's URL does not authenticate you on another (separate origins + separate DBs).

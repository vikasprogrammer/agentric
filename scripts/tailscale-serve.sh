#!/usr/bin/env bash
# Expose up to 3 local tenant processes on THIS node's Tailscale MagicDNS name.
#
# Tailscale serves HTTPS on three ports — 443, 8443, 10000 — each with the node's auto cert. We map
# one tenant port onto each, so every tenant is a SEPARATE ORIGIN (distinct https URL). That gives
# clean per-tenant cookie isolation with ZERO app changes — the app inside each process just thinks
# it's at "/" on its own port. This is why ≤3 tenants fit a single ts.net name.
#
#   scripts/tailscale-serve.sh <port1> [port2] [port3]
#   scripts/tailscale-serve.sh 3010 3020 3030
#
# Result (for your-box.tailnet.ts.net):
#   https://your-box.tailnet.ts.net          → 127.0.0.1:3010   (tenant 1)
#   https://your-box.tailnet.ts.net:8443     → 127.0.0.1:3020   (tenant 2)
#   https://your-box.tailnet.ts.net:10000    → 127.0.0.1:3030   (tenant 3)
set -euo pipefail

[ "$#" -ge 1 ] || { echo "usage: tailscale-serve.sh <port1> [port2] [port3]" >&2; exit 1; }
[ "$#" -le 3 ] || { echo "Tailscale serves HTTPS on 3 ports max (443/8443/10000)." >&2; exit 1; }

HTTPS_PORTS=(443 8443 10000)
i=0
for backend in "$@"; do
  hp="${HTTPS_PORTS[$i]}"
  echo "→ https :$hp  ⇒  http://127.0.0.1:$backend"
  tailscale serve --bg --https="$hp" "http://127.0.0.1:$backend"
  i=$((i + 1))
done

echo
tailscale serve status

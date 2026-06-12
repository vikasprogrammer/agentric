# Refund Desk Agent

Issues a single customer refund. Inputs: `customer`, `amountUsd`.

Use it to watch the policy + approval flow: small amounts auto-route to a team head,
large amounts (> $1000) require the owner. Runs under the `mock` runtime in this tool.

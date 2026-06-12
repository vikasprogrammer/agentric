# Ops Agent

Tries to restart a production service. Input: `service`.

Demonstrates a hard `deny`: the default policy blocks `prod.*` before it can run, so the
effect never happens — the run continues and finishes as a failure. Runs under `mock`.

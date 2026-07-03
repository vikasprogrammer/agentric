/**
 * Claude Code runtime adapter — REFERENCE SKETCH.
 *
 * This is how a real agent (running `claude --print`) routes its side effects through
 * the gateway. The key idea: the agent process must NOT be able to touch the outside
 * world directly. Two enforcement mechanisms, used together:
 *
 *   A) Dangerous effects are exposed ONLY as OS-fronted MCP tools.
 *      Don't grant the agent raw `Bash` to `curl …stripe…`. Instead serve a
 *      `stripe.refund` tool from an MCP server that calls `gateway.invoke(...)`.
 *      The agent literally cannot refund except through the front door.
 *
 *   B) Everything else is gated by a PreToolUse hook.
 *      Claude Code runs a PreToolUse hook before each tool call that returns an
 *      AUTHORITATIVE allow/deny/ask decision. The hook turns the pending tool call into
 *      an ActionAttempt, asks the gateway (Policy → Approvals → Budget → Audit), and emits
 *      the verdict — which BYPASSES Claude's own permission engine. So the gate hook is the
 *      single authority; `--permission-mode` is neither set nor needed (one brain, not two).
 *
 * Wiring (out of process, omitted in this starter):
 *   - spawn: claude --print --output-format stream-json --model <model>
 *            --mcp-config <os-gateway-mcp>  --settings <hooks-with-PreToolUse>
 *   - a small local bridge (unix socket / HTTP) lets the hook + MCP server reach this
 *     process's `gateway.invoke`, carrying the run id so the right RunContext is used.
 *   - parse stream-json for the final `[OUTCOME:success|failure]` marker → Outcome.
 */
import { Act, AgentManifest, Outcome, Run, RunContext, RuntimeAdapter } from '../types';

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly kind = 'claude-code' as const;

  async run(_run: Run, _ctx: RunContext, _act: Act, _manifest: AgentManifest): Promise<{ outcome: Outcome }> {
    throw new Error(
      'ClaudeCodeAdapter is a reference sketch in this starter. ' +
        'Implement the spawn + PreToolUse-hook/MCP bridge described in this file, ' +
        'then route every intercepted tool call through `act` (the gateway).',
    );
  }
}

/**
 * RUNTIME CLI UPDATE WATCH — the sibling of `update-watch.ts`, over a different subject: the `claude`
 * CLI that every session actually launches.
 *
 * The mechanism was already complete before this file existed. `checkDepUpdates()` asks the npm registry
 * for `latest` and flags a stale install; `updateNpmDep('claude')` upgrades it in place. What was missing
 * was the same thing that was missing for the OS itself — **anyone asking on a timer**. Both only ran
 * when a human had Settings → System open, which on a headless box is never. A box pinned to a months-old
 * `claude` reports a green "all dependencies installed" and looks perfectly healthy.
 *
 * ── Why this is NOT just the OS watcher pointed at npm ──────────────────────────────────────────────
 *
 * Updating Agentric moves code we wrote and gate with a test suite. Updating the runtime CLI can add
 * **tools** — and the gate hook's tool→capability table ends in `*) exit 0`, meaning any tool it has no
 * row for is treated as "not a world side effect" and runs ungoverned. That is not hypothetical: claude
 * 2.1.224 shipped cross-session messaging, whose `SendMessage`/`ListAgents` reach every session owned by
 * the same OS user on the machine — the whole fleet, across tenants — with no policy check, no audit and
 * none of the run-as identity the governed paths carry. It fell straight through the `*)` arm.
 *
 * So a CLI upgrade is a governance event, and this watcher is shaped by that:
 *
 *   • **There is no unattended tier, and there should not be one.** The strongest mode is `ask`. An
 *     upgrade that can widen the ungoverned surface must not land while nobody is looking, however
 *     convenient that would be. (`docs/codex-runtime.md` already records the same stance from the other
 *     direction: in-pane CLI self-update is switched off because Agentric pins the runtime deliberately.)
 *   • **The approval names the risk in the specific.** The card says which version the gate hook's
 *     routing was last signed off against and which version you are moving to, so "assume new channels"
 *     becomes a diff a person can actually go and do.
 *   • **Approving IS the review.** On approval the new version is stamped into
 *     `settings.gateReviewedRuntimeVersion`, so the next card can say what has changed since a human last
 *     looked, instead of repeating a standing warning everyone learns to scroll past.
 *
 * ── What an upgrade does to running work ────────────────────────────────────────────────────────────
 * Nothing, immediately: a live session already spawned its `claude` process and keeps the old binary
 * until it ends. The new CLI applies to the NEXT session, which is also when a newly-added tool would
 * first appear. Worth saying on the card, because "I upgraded and nothing changed" is otherwise read as
 * a failed upgrade.
 */
import { AgentOS } from '../kernel';
import { TerminalManager } from '../terminal';
import { ActionAttempt, ApprovalLevel, Decision, RunContext } from '../types';
import { Audience } from '../governance/recipients';
import { stricterDecision } from '../governance/host-match';
import { UpdateWatchMode } from '../governance/settings';
import { checkDeps, checkDepUpdates, updateNpmDep, DepStatus } from './deps';

/** The inbox `system:<topic>` sentinel every card this watcher posts hangs off. */
const TOPIC = 'runtime-update';
/** The capability the upgrade lane is classified as — the handle a policy rule can tighten or deny. */
export const RUNTIME_UPDATE_CAPABILITY = 'runtime.update';
/** The dep this watches. The only runtime CLI carrying an `npmPkg`, and the one every session launches. */
const BIN = 'claude';
const AUDIENCE: Audience = { kind: 'approvers', level: 'owner' };
/** The floor every classification is folded against — policy may tighten this, never loosen it. */
const ASK_OWNER: Decision = {
  effect: 'approve',
  riskClass: 'red',
  level: 'owner',
  reason: 'a runtime CLI upgrade can add tools the gate does not route — an owner decides',
};

export type RuntimeWatchAction =
  | 'off'
  | 'up-to-date'
  | 'not-installed'   // no claude on the box — a different problem, and Settings → System already says so
  | 'error'           // registry/probe failed — reported, not swallowed
  | 'duplicate'       // already carded this exact version
  | 'notified'
  | 'requested'
  | 'denied'          // policy refuses the upgrade lane; notified instead
  | 'applying';

export interface RuntimeWatchResult {
  action: RuntimeWatchAction;
  mode: UpdateWatchMode;
  installed: string;
  latest: string;
  error?: string;
}

/** An upgrade is in flight. Module-level: the CLI is one binary on the box, shared by every tenant. */
let applying = false;

export class RuntimeUpdateWatch {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  private audit(type: string, data: Record<string, unknown>): void {
    this.os.audit.append({ ts: Date.now(), runId: `system:${TOPIC}`, tenant: this.os.tenant, principal: 'system', type, data });
  }

  /** Versions this watcher has already carded and not yet had resolved. */
  private openHeads(): string[] {
    return this.os.db
      .prepare(`SELECT args FROM messages WHERE session_id = ? AND status IN ('open','pending')`)
      .all<{ args: string | null }>(`system:${TOPIC}`)
      .map((r) => { try { return String((JSON.parse(r.args || '{}') as { latest?: unknown }).latest ?? ''); } catch { return ''; } });
  }

  /** One line naming what a human is being asked to vouch for, in the specific rather than the abstract. */
  private gateNote(latest: string): string {
    const reviewed = this.os.settings.gateReviewedRuntimeVersion();
    return `\n\nA new CLI can add TOOLS the gate hook has no routing row for — those fall through to its \`*) exit 0\` arm and run ungoverned (claude 2.1.224's cross-session messaging was exactly that). ` +
      (reviewed
        ? `The gate's tool routing was last signed off against **v${reviewed}**; this moves it to **v${latest}**. Check that release range's notes for new tools before approving.`
        : `No version has been signed off against this box's gate routing yet — check v${latest}'s release notes for new tools before approving.`) +
      `\n\nRunning sessions keep the CLI they launched with; the new one applies to the NEXT session.`;
  }

  /** One pass. Never throws — it rides a shared upkeep timer. */
  async run(opts: { force?: boolean } = {}): Promise<RuntimeWatchResult> {
    const cfg = this.os.settings.runtimeWatch();
    const base = { mode: cfg.mode, installed: '', latest: '' };
    if (cfg.mode === 'off' && !opts.force) return { ...base, action: 'off' };
    if (applying) return { ...base, action: 'applying' };

    let dep: DepStatus | undefined;
    try {
      const report = await checkDepUpdates(checkDeps(), true);
      dep = report.deps.find((d) => d.bin === BIN);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.audit('runtime.check.failed', { bin: BIN, error });
      return { ...base, action: 'error', error };
    }
    if (!dep) return { ...base, action: 'error', error: `no '${BIN}' dependency is declared` };
    // Not installed is a real problem, but a DIFFERENT one — and Settings → System already reports it
    // loudly. Carding it here too would just be a second voice saying the same thing.
    if (!dep.installed) return { ...base, action: 'not-installed' };

    const installed = dep.version || '';
    const latest = dep.latest || '';
    const facts = { bin: BIN, installed, latest };
    if (dep.updateError) {
      this.audit('runtime.check.failed', { ...facts, error: dep.updateError });
      return { ...base, ...facts, action: 'error', error: dep.updateError };
    }
    if (!dep.updateAvailable) {
      const closed = this.tm.closeSystemCards(TOPIC, 'cancelled');
      if (closed) this.audit('runtime.notice.retired', { ...facts, closed });
      return { ...base, ...facts, action: 'up-to-date' };
    }
    if (this.openHeads().includes(latest)) return { ...base, ...facts, action: 'duplicate' };

    const summary = `The \`${BIN}\` CLI on this box is **v${installed}**; the registry has **v${latest}**.`;

    if (cfg.mode === 'notify') {
      const id = this.tm.postSystemCard({
        topic: TOPIC, type: 'notification',
        title: `Agent runtime update available — claude v${latest}`,
        body: `${summary}${this.gateNote(latest)}\n\nUpgrade it from Settings → System → Dependencies.`,
        audience: AUDIENCE,
        args: { kind: 'available', latest, installed },
      });
      this.tm.closeSystemCards(TOPIC, 'cancelled', id);
      this.audit('runtime.update.available', facts);
      return { ...base, ...facts, action: 'notified' };
    }

    // ── ask mode ────────────────────────────────────────────────────────────────────────────────────
    const attempt: ActionAttempt = {
      capabilityId: RUNTIME_UPDATE_CAPABILITY,
      args: { bin: BIN, from: installed, to: latest },
      reasoning: `upgrade the ${BIN} CLI to v${latest}`,
    };
    const ctx = {
      run: { id: `system:${TOPIC}`, tenant: this.os.tenant, principal: 'system' },
      secrets: this.os.secrets, audit: this.os.audit, log: () => undefined,
    } as unknown as RunContext;
    const decision = stricterDecision(this.os.policy.classify(attempt, ctx), ASK_OWNER);
    this.audit('runtime.gate.decision', { ...facts, decision });

    if (decision.effect === 'deny') {
      const id = this.tm.postSystemCard({
        topic: TOPIC, type: 'notification',
        title: `Agent runtime update available — claude v${latest} (upgrade disabled by policy)`,
        body: `${summary}\n\nThis workspace's policy denies \`${RUNTIME_UPDATE_CAPABILITY}\`, so the box will not upgrade its own runtime — do it from the deploy host if you want it.\nReason: ${decision.reason}`,
        audience: AUDIENCE,
        args: { kind: 'denied', latest, installed },
      });
      this.tm.closeSystemCards(TOPIC, 'cancelled', id);
      this.audit('runtime.update.denied', { ...facts, reason: decision.reason });
      return { ...base, ...facts, action: 'denied' };
    }

    // Floored at ASK_OWNER, so `approve` is the only surviving effect — `allow` cannot reach here.
    const level: ApprovalLevel = decision.effect === 'approve' ? decision.level : 'owner';
    const { req, decision: settle } = this.os.approvals.request({
      runId: `system:${TOPIC}`, tenant: this.os.tenant, level, attempt, reason: decision.reason,
    });
    const id = this.tm.postSystemCard({
      topic: TOPIC, type: 'approval',
      title: `Approve agent runtime upgrade — claude v${latest}`,
      body: `${summary}${this.gateNote(latest)}\n\nApproving runs \`npm install -g @anthropic-ai/claude-code@latest\` on this box and records v${latest} as the version its gate routing has been signed off against.`,
      audience: AUDIENCE,
      approvalId: req.id, level, capability: RUNTIME_UPDATE_CAPABILITY,
      args: { kind: 'approval', latest, installed },
    });
    this.tm.closeSystemCards(TOPIC, 'cancelled', id);
    this.audit('runtime.update.requested', { ...facts, approvalId: req.id, level });

    void settle
      .then((approved) => (approved ? this.apply(installed, latest) : this.audit('runtime.update.rejected', facts)))
      .catch(() => { /* a settled-then-crashed waiter must not take the process with it */ });

    return { ...base, ...facts, action: 'requested' };
  }

  /** Run the approved upgrade and report the outcome. A silent failure leaves the box on the old CLI
   *  while the card says it was approved — which reads as done. */
  private async apply(from: string, to: string): Promise<void> {
    if (applying) return;
    applying = true;
    this.audit('runtime.update.applying', { bin: BIN, from, to });
    try {
      const r = await updateNpmDep(BIN);
      const after = r.report.deps.find((d) => d.bin === BIN);
      if (r.ok) {
        // Stamp what the approval actually vouched for: the version now on the box, not the version the
        // card was raised about — an upgrade races the registry and can land on something newer.
        const landed = after?.version || to;
        this.os.settings.setGateReviewedRuntimeVersion(landed, 'system');
        this.audit('runtime.update.applied', { bin: BIN, from, to, landed });
        this.tm.postSystemCard({
          topic: TOPIC, type: 'notification',
          title: `Agent runtime upgraded — claude v${landed}`,
          body: `\`${BIN}\` is now v${landed} (was v${from}). Sessions already running keep the old CLI until they end; the next session launches on this one.\n\nv${landed} is recorded as the version this box's gate routing has been signed off against.`,
          audience: AUDIENCE,
          args: { kind: 'applied', latest: landed, installed: from },
        });
        return;
      }
      const failed = r.steps.filter((s) => !s.ok).map((s) => s.cmd);
      this.audit('runtime.update.failed', { bin: BIN, from, to, error: r.error, failed });
      this.tm.postSystemCard({
        topic: TOPIC, type: 'notification',
        title: `Agent runtime upgrade to v${to} FAILED`,
        body: `${r.error ?? 'the upgrade did not complete'}${failed.length ? `\nFailed step: ${failed.join(', ')}` : ''}\n\nThe box is still on v${after?.version || from}. Settings → System → Dependencies has the full log.`,
        audience: AUDIENCE,
        args: { kind: 'failed', latest: to, installed: from },
      });
    } catch (e) {
      this.audit('runtime.update.failed', { bin: BIN, from, to, error: e instanceof Error ? e.message : String(e) });
    } finally {
      applying = false;
    }
  }
}

/** Test hook — clears the module-level in-flight latch between in-process cases. */
export function __resetRuntimeWatch(): void { applying = false; }

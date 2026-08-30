/**
 * UPDATE WATCH — the self-update *watcher*, on top of the self-update *mechanism* in `updater.ts`.
 *
 * `updater.ts` has always been able to answer "is this checkout behind origin?" and to apply an update
 * (ff-pull → rebuild both bundles → detached restart). What it never had was anyone asking. The only
 * callers were console routes, so the check ran exactly when a human had the console open — which on a
 * headless remote box is never. The observable result: boxes drifted for weeks (the fleet has repeatedly
 * been found 13+ versions behind), and nothing anywhere said so.
 *
 * This adds the two missing halves, as two modes:
 *
 *   • **notify** (default) — a periodic check that posts an Inbox card and DMs the owner when the box
 *     falls behind. Pure signal; applies nothing. This is the half that ends the silent-drift class.
 *   • **ask** — additionally raises an OWNER approval. Approving it applies the update on the box
 *     itself, so one tap from a phone replaces an ssh session. The approval IS the human's choice of
 *     moment, which is why this tier needs no quiet-window logic of its own.
 *
 * Unattended apply is deliberately NOT a mode here. It needs a soak (don't take origin's HEAD until it
 * has been live somewhere else), and post-restart verification with rollback — without which a bad build
 * is respawned into brokenness forever by the supervisor. Both are real work; neither is a prerequisite
 * for the two modes above, which is why they ship first.
 *
 * ── Governance ──────────────────────────────────────────────────────────────────────────────────────
 * Applying an update is a side effect on the world, so `ask` mode routes it through the same planes
 * everything else uses: Policy classifies `os.update`, Approvals suspends for a human, Audit records
 * every step. Two deliberate properties:
 *   - The decision is **floored** at ask/owner (`stricterDecision`): a permissive tenant policy can
 *     never turn a self-update into something that applies unattended. Policy can only tighten it.
 *   - A tenant that hard-denies `os.update` genuinely disables the apply lane — the watcher then still
 *     NOTIFIES, because knowing you are behind is not the same permission as changing the box.
 *
 * ── One card per update ─────────────────────────────────────────────────────────────────────────────
 * Notifications are deduped on the upstream commit (`status.head`), not on the version string or the
 * behind-count: `latest` repeats across commits and `behind` changes every time origin moves, so either
 * would re-card a busy dev box on every tick. When origin moves on, the previous card is superseded
 * rather than left to pile up.
 *
 * ── Known limit, worth stating ──────────────────────────────────────────────────────────────────────
 * `applyUpdate` restarts ONE service (`AOS_RESTART_CMD`, else the launchd label / systemd unit for this
 * tenant). Where two tenants share a checkout — the Mac's `agent-os-live` serves instapods AND personal
 * — updating from one leaves the other running old code out of the same freshly-built directory. That is
 * the bug `AOS_LIVE_TARGETS` fixed for `make-live.sh`. Set `AOS_RESTART_CMD` to bounce every label on a
 * shared checkout, or keep such boxes on `notify`.
 */
import { AgentOS } from '../kernel';
import { TerminalManager } from '../terminal';
import { ActionAttempt, ApprovalLevel, Decision, RunContext } from '../types';
import { Audience } from '../governance/recipients';
import { stricterDecision } from '../governance/host-match';
import { UpdateWatchMode } from '../governance/settings';
import { applyUpdate, checkForUpdate, UpdateStatus } from './updater';

/** The inbox `system:<topic>` sentinel every card this watcher posts hangs off. */
const TOPIC = 'update';
/** The capability the apply lane is classified as — the handle a policy rule can tighten or deny. */
export const UPDATE_CAPABILITY = 'os.update';
/** Whom an update concerns: the people who could actually act on it. */
const AUDIENCE: Audience = { kind: 'approvers', level: 'owner' };
/** The floor every classification is folded against — policy may tighten this, never loosen it. */
const ASK_OWNER: Decision = {
  effect: 'approve',
  riskClass: 'red',
  level: 'owner',
  reason: 'updating the box is an owner decision',
};

export type UpdateWatchAction =
  | 'off'            // the watcher is disabled on this box
  | 'up-to-date'     // nothing to do (any stale card retired)
  | 'error'          // the git fetch/compare failed — reported, not swallowed
  | 'duplicate'      // already carded this exact upstream commit
  | 'blocked'        // behind, but a dirty tree means an ff-only apply can't run
  | 'notified'       // behind → card + DM posted
  | 'requested'      // behind → owner approval raised (ask mode)
  | 'denied'         // behind → policy refuses the apply lane; notified instead
  | 'applying';      // an apply from a previous approval is still running

export interface UpdateWatchResult {
  action: UpdateWatchAction;
  mode: UpdateWatchMode;
  behind: number;
  current: string;
  latest: string;
  head: string;
  /** Populated on `blocked` — the tracked files standing in the way, so the card can name them. */
  dirtyFiles?: string[];
  error?: string;
}

/** An apply is in flight (module-level: the checkout is process-wide, like `updater.ts`'s own cache).
 *  Without it, a tick landing while a pull+rebuild runs would start a second one over the same tree. */
let applying = false;

export class UpdateWatch {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  private audit(type: string, data: Record<string, unknown>): void {
    this.os.audit.append({ ts: Date.now(), runId: `system:${TOPIC}`, tenant: this.os.tenant, principal: 'system', type, data });
  }

  /** Open (unresolved) cards this watcher has posted, newest first, with their parsed args. */
  private openCards(): Array<{ id: string; head: string; kind: string }> {
    return this.os.db
      .prepare(`SELECT id, args FROM messages WHERE session_id = ? AND status IN ('open','pending') ORDER BY created_at DESC`)
      .all<{ id: string; args: string | null }>(`system:${TOPIC}`)
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate a corrupt payload */ }
        return { id: r.id, head: String(a.head ?? ''), kind: String(a.kind ?? '') };
      });
  }

  /**
   * One pass. Safe to call on a timer or from a route; never throws — a watcher that can crash the
   * upkeep loop it rides on would take out the janitor and memory maintenance with it.
   */
  async run(opts: { force?: boolean } = {}): Promise<UpdateWatchResult> {
    const cfg = this.os.settings.updateWatch();
    const base = { mode: cfg.mode, behind: 0, current: '', latest: '', head: '' };
    if (cfg.mode === 'off' && !opts.force) return { ...base, action: 'off' };
    if (applying) return { ...base, action: 'applying' };

    let status: UpdateStatus;
    try {
      // Always force: this watcher's cadence IS the cadence, and a cached answer would just make a tick
      // report what a browser poll happened to fetch earlier.
      status = await checkForUpdate(true);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.audit('update.check.failed', { error });
      return { ...base, action: 'error', error };
    }
    const facts = { behind: status.behind, current: status.current, latest: status.latest, head: status.head };
    if (status.error) {
      this.audit('update.check.failed', { error: status.error });
      return { ...base, ...facts, action: 'error', error: status.error };
    }

    if (!status.updateAvailable) {
      // The update landed (or was applied by hand / by make-live). Retire our own stale cards so the
      // Inbox doesn't keep asking for something that already happened.
      const closed = this.tm.closeSystemCards(TOPIC, 'cancelled');
      if (closed) this.audit('update.notice.retired', { closed, version: status.current });
      return { ...base, ...facts, action: 'up-to-date' };
    }

    // Already told them about THIS commit? Say nothing again. (Deduping on `head` rather than version
    // or behind-count is what keeps a fast-moving dev box from re-carding on every tick.)
    const open = this.openCards();
    if (open.some((c) => c.head === status.head)) return { ...base, ...facts, action: 'duplicate' };

    // A dirty tree can't take an ff-only pull, so there is nothing to approve — but silence here is the
    // failure mode that let a box hand-patched weeks ago quietly stop updating altogether. Card it.
    if (status.dirty) {
      const files = status.dirtyFiles.slice(0, 10);
      const id = this.tm.postSystemCard({
        topic: TOPIC, type: 'notification',
        title: `Update blocked — v${status.latest} can't be applied on this box`,
        body: `This checkout is ${status.behind} commit${status.behind === 1 ? '' : 's'} behind ${status.upstream} (v${status.current} → v${status.latest}), but ${files.length} tracked file${files.length === 1 ? ' has' : 's have'} uncommitted changes, so a fast-forward pull would fail:\n` +
          files.map((f) => `• ${f}`).join('\n') +
          `\n\nCommit, stash or revert them on the box — then the update can proceed. Work left only on a box is one \`git reset --hard\` from being lost.`,
        audience: AUDIENCE,
        args: { kind: 'blocked', head: status.head, latest: status.latest, behind: status.behind, dirtyFiles: files },
      });
      this.tm.closeSystemCards(TOPIC, 'cancelled', id);
      this.audit('update.blocked', { ...facts, dirtyFiles: files });
      return { ...base, ...facts, action: 'blocked', dirtyFiles: status.dirtyFiles };
    }

    const summary = `v${status.current} → v${status.latest} (${status.behind} commit${status.behind === 1 ? '' : 's'} behind ${status.upstream}).` +
      (status.log.length ? `\n\n${status.log.slice(0, 8).map((l) => `• ${l}`).join('\n')}` : '');

    if (cfg.mode === 'notify') {
      const id = this.tm.postSystemCard({
        topic: TOPIC, type: 'notification',
        title: `Update available — v${status.latest}`,
        body: `${summary}\n\nApply it from Settings → Updates, or run the deploy script.`,
        audience: AUDIENCE,
        args: { kind: 'available', head: status.head, latest: status.latest, behind: status.behind },
      });
      this.tm.closeSystemCards(TOPIC, 'cancelled', id);
      this.audit('update.available', facts);
      return { ...base, ...facts, action: 'notified' };
    }

    // ── ask mode: raise an owner approval whose resolution applies the update ────────────────────────
    const attempt: ActionAttempt = {
      capabilityId: UPDATE_CAPABILITY,
      args: { from: status.current, to: status.latest, behind: status.behind },
      reasoning: `self-update this box to v${status.latest}`,
    };
    const ctx = {
      run: { id: `system:${TOPIC}`, tenant: this.os.tenant, principal: 'system' },
      secrets: this.os.secrets, audit: this.os.audit, log: () => undefined,
    } as unknown as RunContext;
    const decision = stricterDecision(this.os.policy.classify(attempt, ctx), ASK_OWNER);
    this.audit('update.gate.decision', { ...facts, decision });

    if (decision.effect === 'deny') {
      // Policy refuses the APPLY. It does not refuse the KNOWLEDGE, so still say the box is behind.
      const id = this.tm.postSystemCard({
        topic: TOPIC, type: 'notification',
        title: `Update available — v${status.latest} (self-update disabled by policy)`,
        body: `${summary}\n\nThis workspace's policy denies \`${UPDATE_CAPABILITY}\`, so the box will not update itself — apply it from the deploy host instead.\nReason: ${decision.reason}`,
        audience: AUDIENCE,
        args: { kind: 'denied', head: status.head, latest: status.latest, behind: status.behind },
      });
      this.tm.closeSystemCards(TOPIC, 'cancelled', id);
      this.audit('update.denied', { ...facts, reason: decision.reason });
      return { ...base, ...facts, action: 'denied' };
    }

    // Floored at ASK_OWNER above, so `approve` is the only surviving effect here — `allow` cannot
    // reach this line, which is exactly the property that keeps a permissive policy from self-applying.
    const level: ApprovalLevel = decision.effect === 'approve' ? decision.level : 'owner';
    const { req, decision: settle } = this.os.approvals.request({
      runId: `system:${TOPIC}`,
      tenant: this.os.tenant,
      level,
      attempt,
      reason: decision.reason,
    });
    const id = this.tm.postSystemCard({
      topic: TOPIC, type: 'approval',
      title: `Approve update — v${status.latest}`,
      body: `${summary}\n\nApproving pulls, rebuilds and restarts THIS box. In-flight sessions are interrupted by the restart, so approve at a moment that suits.`,
      audience: AUDIENCE,
      approvalId: req.id,
      level,
      capability: UPDATE_CAPABILITY,
      args: { kind: 'approval', head: status.head, latest: status.latest, behind: status.behind },
    });
    this.tm.closeSystemCards(TOPIC, 'cancelled', id);
    this.audit('update.requested', { ...facts, approvalId: req.id, level });

    // Deliberately NOT awaited: the human may take hours, and this call rides a timer tick. The waiter
    // is in-memory like every other approval, so a restart before a decision simply drops it — the next
    // tick re-raises the card for the same head, which is the recovery path rather than a leak.
    void settle
      .then((approved) => (approved ? this.apply(status) : this.audit('update.rejected', facts)))
      .catch(() => { /* a settled-then-crashed waiter must not take the process with it */ });

    return { ...base, ...facts, action: 'requested' };
  }

  /** Run the approved update, then report what happened — a self-update that fails silently is worse
   *  than one that never ran, because the box looks current from the outside. */
  private async apply(status: UpdateStatus): Promise<void> {
    if (applying) return;
    applying = true;
    this.audit('update.applying', { from: status.current, to: status.latest, head: status.head });
    try {
      const r = await applyUpdate(this.os.tenant);
      if (r.ok) {
        this.audit('update.applied', { from: status.current, to: status.latest, head: status.head, restarting: r.restarting });
        if (!r.restarting) {
          // Built, but nothing bounced the service — it is still running the OLD code from a NEW tree.
          // That is the one outcome that looks fine and isn't, so it gets its own card.
          this.tm.postSystemCard({
            topic: TOPIC, type: 'notification',
            title: `Update built — restart this box by hand`,
            body: `v${status.latest} is built on disk, but no restart command could be resolved for this platform, so the service is still running v${status.current}. Restart it, or set AOS_RESTART_CMD.`,
            audience: AUDIENCE,
            args: { kind: 'manual-restart', head: status.head, latest: status.latest },
          });
        }
        return;
      }
      const failed = r.steps.filter((s) => !s.ok).map((s) => s.cmd);
      this.audit('update.failed', { from: status.current, to: status.latest, error: r.error, failed });
      this.tm.postSystemCard({
        topic: TOPIC, type: 'notification',
        title: `Update to v${status.latest} FAILED`,
        body: `${r.error ?? 'the update did not complete'}${failed.length ? `\nFailed step: ${failed.join(', ')}` : ''}\n\nThe box is still on v${status.current}. Settings → Updates has the full log.`,
        audience: AUDIENCE,
        args: { kind: 'failed', head: status.head, latest: status.latest },
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.audit('update.failed', { from: status.current, to: status.latest, error });
    } finally {
      applying = false;
    }
  }
}

/** Test hook — clears the module-level in-flight latch between in-process cases. */
export function __resetUpdateWatch(): void { applying = false; }

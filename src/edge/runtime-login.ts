/**
 * Guided runtime-account login — adding a pooled account from the console instead of over ssh.
 *
 * A runtime account has to be a credential DIRECTORY: the CLI's own `login` writes an access + refresh
 * token pair into it, and that is the only credential the interactive lane authenticates with (see
 * `CodingRuntimeSpec.liveCredentialKinds` for the evidence). Producing one used to mean ssh'ing to the box
 * and running `CLAUDE_CONFIG_DIR=<dir> claude` by hand — so the easy path in the console was pasting a
 * setup-token, which silently did nothing. This module makes the working path the easy one.
 *
 * WHY IT DRIVES THE REAL CLI RATHER THAN SPEAKING OAUTH ITSELF. We could mint our own PKCE pair, hit the
 * authorize + token endpoints, and write `.credentials.json` ourselves. That means owning an undocumented
 * client id, token endpoint and file shape, and every one of those can change under us — the failure mode
 * being a credential file the CLI silently rejects, which is the exact class of bug this whole surface is
 * cleaning up. Instead the runtime's own binary performs the exchange and writes its own file. We only
 * (a) relay the authorize URL it prints and (b) type back the code the human pastes.
 *
 * The success signal is therefore a FILESYSTEM fact — the credential file the runtime wrote — never a
 * screen scrape. Scraping decides only when to press Enter and which URL to show; if the CLI's prompts
 * change, the flow times out with the manual instructions instead of registering a broken account.
 *
 * Local-lane only: the uid-isolation backend runs sessions on a uid-private socket the app can't capture,
 * so `start()` refuses there and points at the manual path. Panes are short-lived and swept on a TTL.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CodingRuntimeId, CODING_RUNTIMES } from '../types';
import { SessionBackend } from './session-backend';
import { RuntimeAccountStore } from '../state/runtime-accounts';

/** How long a half-finished login may hold a pane before it's swept (the human has to visit a browser,
 *  so this is generous; the OAuth code itself expires well inside it). */
const TTL_MS = 15 * 60_000;
/** The runtime's own login is the only thing that writes the credential file, so polling for it IS the
 *  completion check. Between the code being typed and the file appearing there's a token exchange. */
const EXCHANGE_GRACE_MS = 60_000;

export type LoginPhase = 'starting' | 'awaiting-code' | 'exchanging' | 'done' | 'failed';

export interface LoginState {
  id: string;
  runtime: CodingRuntimeId;
  /** The account name the credential dir will be registered under once the login completes. */
  name: string;
  phase: LoginPhase;
  /** The authorize URL the CLI printed — what the human opens. Present from `awaiting-code` on. */
  url?: string;
  /** Why it failed, in operator language, with the manual fallback when relevant. */
  error?: string;
  startedAt: number;
}

interface Login extends LoginState {
  dir: string;
  tmux: string;
  /** Prompts already answered, so a poll can't press Enter twice on the same screen. */
  answered: Set<string>;
  codeAt?: number;
}

/** The authorize URL, as printed in the pane. The pane is spawned wide enough that the CLI prints it on
 *  ONE line (see `cols` at spawn) — a hard-wrapped URL cannot be reassembled reliably, so the width is
 *  the guarantee here, and `looksWhole` below refuses to show a URL that arrived clipped anyway. */
const URL_RE = /https:\/\/[^\s]*oauth\/authorize\?[^\s]+/;
/** An OAuth authorize URL that lost its tail is worse than none: the human would authorize into a
 *  broken request and blame the product. Every provider's URL carries `state` last-ish, so require it. */
const looksWhole = (u: string): boolean => /[?&]state=[^&\s]+/.test(u);
/** Prompts the CLI shows before it gets to the browser step, each answered by accepting the highlighted
 *  default (theme → any; login method → "Claude account with subscription", which is what a pooled
 *  account must be). Matching on the question text, not on option numbering, which is likelier to shift. */
const PROMPTS: { key: string; re: RegExp }[] = [
  { key: 'theme', re: /Choose the text style/i },
  { key: 'method', re: /Select login method/i },
];
/** The CLI rejected the pasted code — worth surfacing verbatim rather than waiting out the TTL. */
const BAD_CODE_RE = /(invalid|expired|failed).{0,30}(code|token|authoriz)/i;

export class RuntimeLoginManager {
  private readonly logins = new Map<string, Login>();

  constructor(private readonly deps: {
    backend: SessionBackend;
    /** Parent dir for credential dirs — inside the tenant's data home, so an account is part of the
     *  tenant's state (and the tenant boundary) rather than loose in the service user's home. */
    accountsDir: string;
    accounts: RuntimeAccountStore;
    audit: (type: string, data: Record<string, unknown>) => void;
  }) {}

  /** Is a guided login possible on this box at all? False under uid isolation (uid-private tmux socket)
   *  or when the runtime's binary isn't installed — both worth telling the operator BEFORE they start. */
  supported(runtime: CodingRuntimeId): { ok: boolean; why?: string } {
    if (!CODING_RUNTIMES[runtime].guidedLogin) return { ok: false, why: `${CODING_RUNTIMES[runtime].label} has no guided login yet — add a credential dir by path instead` };
    if (!this.deps.accountsDir) return { ok: false, why: 'this instance has no data home to store credential dirs in' };
    if (process.env.AOS_UID_ISOLATION === '1') return { ok: false, why: 'guided login is unavailable under OS uid isolation — run the login on the box and add the dir by path' };
    return { ok: true };
  }

  list(): LoginState[] {
    this.sweep();
    return [...this.logins.values()].map(toState);
  }

  /** Spawn the runtime's login in a throwaway pane pointed at a fresh credential dir. Returns
   *  immediately in `starting`; the console polls for the URL. */
  start(runtime: CodingRuntimeId, name: string): LoginState {
    this.sweep();
    const clean = name.trim();
    if (!clean) throw new Error('account name required');
    // The dir is named after the account, so what's on disk stays readable months later. Keep it to
    // path-safe characters rather than sanitising silently — a surprising dir name is a support call.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,40}$/.test(clean)) throw new Error('account name may use letters, numbers, spaces, dashes and underscores');
    if (this.deps.accounts.get(runtime, clean)) throw new Error(`an account named "${clean}" already exists for this runtime`);
    const sup = this.supported(runtime);
    if (!sup.ok) throw new Error(sup.why!);
    for (const l of this.logins.values()) {
      if (l.runtime === runtime && l.name === clean && (l.phase === 'starting' || l.phase === 'awaiting-code')) return toState(l);
    }

    const spec = CODING_RUNTIMES[runtime];
    const dir = path.join(this.deps.accountsDir, runtime, clean.replace(/\s+/g, '-'));
    // A dir that already holds a login would let the flow "succeed" instantly against someone else's
    // credentials — the operator would never see the browser step and would register the wrong account.
    if (fs.existsSync(path.join(dir, spec.credentialEnv.configDirFile))) {
      throw new Error(`${dir} already holds a login — remove it first, or add it as a credential dir by path`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = 'lg_' + crypto.randomBytes(6).toString('hex');
    const tmux = `aos-login-${id}`;
    // No launch script, no gate hook: this pane runs ONLY the vendor CLI's login and is killed the moment
    // the credential file lands. It never gets a task, an agent dir, or the session env.
    this.deps.backend.spawn('', {
      sessionId: id, agent: 'runtime-login', tmuxName: tmux,
      env: { [spec.credentialEnv.configDirVar]: dir },
      argv: [spec.bin],
      // Wide pane on purpose: nobody attaches to this one, and the authorize URL is ~400 chars. A TUI
      // hard-wraps to its terminal width and emits real newlines, which `capture-pane -J` will not
      // rejoin — at the default 203 columns the URL came back truncated at the wrap point (caught by a
      // live run against the real CLI, not by the stubbed test). Giving the pane room is the fix that
      // needs no reassembly heuristic.
      cols: 900,
    });
    const login: Login = { id, runtime, name: clean, phase: 'starting', startedAt: Date.now(), dir, tmux, answered: new Set() };
    this.logins.set(id, login);
    this.deps.audit('runtime.account.login.started', { runtime, name: clean, dir });
    return toState(login);
  }

  /**
   * Advance one login and report it. Called by the console's poll — there is no background timer, so a
   * flow only moves while someone is watching it, and an abandoned one is swept by TTL.
   */
  poll(id: string): LoginState | null {
    const l = this.logins.get(id);
    if (!l) return null;
    if (l.phase === 'done' || l.phase === 'failed') return toState(l);

    // Completion is the credential file the runtime itself wrote — checked before anything on screen, so
    // a finished login is registered even if the pane rendered something we don't recognise.
    if (fs.existsSync(path.join(l.dir, CODING_RUNTIMES[l.runtime].credentialEnv.configDirFile))) return toState(this.finish(l));

    if (Date.now() - l.startedAt > TTL_MS) return toState(this.fail(l, 'the login timed out — start it again, or run it on the box and add the dir by path'));

    const pane = this.deps.backend.capturePane('', l.tmux);
    if (pane == null) return toState(this.fail(l, 'the login process is no longer running — start it again'));

    if (BAD_CODE_RE.test(pane)) return toState(this.fail(l, 'the runtime rejected that code — start again and copy the code from the browser exactly'));

    // Answer each pre-browser prompt once, by accepting its highlighted default.
    for (const p of PROMPTS) {
      if (!l.answered.has(p.key) && p.re.test(pane)) {
        this.deps.backend.injectText('', l.tmux, '', true);
        l.answered.add(p.key);
        return toState(l); // one screen per poll — let the next render land before reading again
      }
    }

    const url = pane.match(URL_RE)?.[0];
    if (url && l.phase === 'starting') {
      if (!looksWhole(url)) return toState(this.fail(l, 'the sign-in link came back incomplete from the runtime — start it again, or run the login on the box and add the dir by path'));
      l.phase = 'awaiting-code';
      l.url = url;
    }
    // The code was typed but no credential file yet: either the exchange is in flight, or the CLI is
    // sitting on an error we don't have a pattern for. Don't wait out the full TTL for the latter.
    if (l.phase === 'exchanging' && l.codeAt && Date.now() - l.codeAt > EXCHANGE_GRACE_MS) {
      return toState(this.fail(l, 'the runtime did not complete the sign-in after the code was submitted — start again, or run the login on the box and add the dir by path'));
    }
    return toState(l);
  }

  /** Type the code the human pasted from the browser into the waiting pane. The code is a one-time
   *  OAuth artifact: it is never audited, logged, or persisted. */
  submitCode(id: string, code: string): LoginState {
    const l = this.logins.get(id);
    if (!l) throw new Error('login not found');
    if (l.phase !== 'awaiting-code') throw new Error(`this login is ${l.phase}, not waiting for a code`);
    const clean = code.trim();
    if (!clean) throw new Error('code required');
    if (!this.deps.backend.injectText('', l.tmux, clean, true)) throw new Error('could not reach the login process — start it again');
    l.phase = 'exchanging';
    l.codeAt = Date.now();
    return toState(l);
  }

  /** Give up on a login: kill the pane and remove the half-built credential dir, so a retry starts clean
   *  rather than tripping the "already holds a login" guard on a partial write. */
  cancel(id: string): void {
    const l = this.logins.get(id);
    if (!l) return;
    this.kill(l);
    this.logins.delete(id);
    this.deps.audit('runtime.account.login.cancelled', { runtime: l.runtime, name: l.name });
  }

  /** The login wrote its credential file: kill the pane and register the dir as a pooled account. */
  private finish(l: Login): Login {
    this.kill(l, { keepDir: true });
    l.phase = 'done';
    try {
      if (!this.deps.accounts.get(l.runtime, l.name)) {
        this.deps.accounts.add({ runtime: l.runtime, name: l.name, kind: 'oauth', configDir: l.dir });
      }
      this.deps.audit('runtime.account.login.completed', { runtime: l.runtime, name: l.name, dir: l.dir });
    } catch (e) {
      l.phase = 'failed';
      l.error = `signed in, but the account could not be saved: ${(e as Error).message}`;
    }
    return l;
  }

  private fail(l: Login, why: string): Login {
    this.kill(l);
    l.phase = 'failed';
    l.error = why;
    this.deps.audit('runtime.account.login.failed', { runtime: l.runtime, name: l.name, error: why });
    return l;
  }

  private kill(l: Login, opts?: { keepDir: boolean }): void {
    try { this.deps.backend.kill('', l.tmux); } catch { /* pane may already be gone */ }
    if (opts?.keepDir) return;
    // Only ever removes a dir this manager created for this attempt, and only when it holds no login.
    try {
      if (!fs.existsSync(path.join(l.dir, CODING_RUNTIMES[l.runtime].credentialEnv.configDirFile))) {
        fs.rmSync(l.dir, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }

  /** Drop finished entries and reap abandoned panes — a browser tab closed mid-flow must not leave a
   *  `claude` sitting on a prompt forever. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, l] of this.logins) {
      const settled = l.phase === 'done' || l.phase === 'failed';
      if (settled && now - l.startedAt > TTL_MS) { this.logins.delete(id); continue; }
      if (!settled && now - l.startedAt > TTL_MS) this.fail(l, 'the login timed out — start it again');
    }
  }
}

const toState = (l: Login): LoginState => ({
  id: l.id, runtime: l.runtime, name: l.name, phase: l.phase, url: l.url, error: l.error, startedAt: l.startedAt,
});

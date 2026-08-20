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
import { credentialDirHasLogin, keychainForget } from './runtime-account-check';

/** How long a half-finished login may hold a pane before it's swept (the human has to visit a browser,
 *  so this is generous; the OAuth code itself expires well inside it). */
const TTL_MS = 15 * 60_000;
/** The runtime's own login is the only thing that writes the credential file, so polling for it IS the
 *  completion check. Between the code being typed and the file appearing there's a token exchange. */
const EXCHANGE_GRACE_MS = 60_000;
/** A freshly-printed authorize URL can be caught mid-render, its `state=` tail not yet on screen. That's
 *  transient — keep polling for a whole URL and only give up if it stays incomplete past this window. */
const URL_SETTLE_MS = 8_000;

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
  /** A recoverable hiccup the human needs to know about while the flow CONTINUES — today: the runtime
   *  rejected a code and the pane has been re-armed with a fresh link. Cleared once they act on it. */
  notice?: string;
  /** How many codes have been rejected so far. Bounded by {@link MAX_CODE_ATTEMPTS}. */
  codeAttempts: number;
  startedAt: number;
}

interface Login extends LoginState {
  dir: string;
  tmux: string;
  /** Prompts already answered, so a poll can't press Enter twice on the same screen. */
  answered: Set<string>;
  codeAt?: number;
  /** When we first saw an authorize URL that wasn't yet whole — lets us wait out a mid-render capture
   *  before deciding the link is genuinely clipped. */
  urlSeenAt?: number;
}

/** The authorize URL, as printed in the pane. The pane is spawned wide enough (see `cols` at spawn) that
 *  the CLI usually prints it on ONE line, and `capture-pane -J` rejoins a soft wrap. Two things still break
 *  a single-line scrape: the CLI can render the URL inside a fixed-width box whose borders force real
 *  newlines `-J` won't rejoin, and a poll can catch the line MID-RENDER before its `state=` tail has landed.
 *  So `extractAuthorizeUrl` reassembles across rows and `looksWhole` still refuses to hand back a URL that
 *  never completed — a clipped link is worse than none (the human authorizes a broken request and blames us). */
const URL_RE = /https:\/\/[^\s]*oauth\/authorize\?[^\s]+/;
const URL_START_RE = /https:\/\/[^\s]*oauth\/authorize\?/;
/** URL-legal characters (RFC 3986 unreserved + the sub-delims OAuth query strings use). A row that is
 *  NOTHING BUT these is a wrapped URL continuation; a row with a space or prose (the "Paste code" prompt)
 *  is not, and ends the URL — so reassembly can never fuse the prompt into the query string. */
const URL_FRAG_RE = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
/** Strip a boxed row's borders/padding (│ ┃ | leading markers, surrounding whitespace) before testing it. */
const BOX_TRIM_RE = /^[\s│┃|>]+|[\s│┃|]+$/g;
/** An OAuth authorize URL that lost its tail is worse than none: the human would authorize into a
 *  broken request and blame the product. Every provider's URL carries `state` last-ish, so require it. */
const looksWhole = (u: string): boolean => /[?&]state=[^&\s]+/.test(u);

/** Pull the authorize URL from a captured pane, reassembling it when the CLI wrapped it across rows (a
 *  bordered box, or a hard wrap `capture-pane -J` left as real newlines). Take the URL-legal run after the
 *  authorize marker, then append each following row that is purely a URL fragment, stopping the moment the
 *  URL is whole or a row carries other text. Returns whatever we have — the caller's `looksWhole` decides
 *  whether it's complete enough to show, so a still-partial reassembly is treated as "not ready yet". */
export function extractAuthorizeUrl(pane: string): string | undefined {
  const lines = pane.split('\n');
  const start = lines.findIndex((l) => URL_START_RE.test(l));
  if (start < 0) return undefined;
  let url = lines[start].match(URL_RE)?.[0];
  if (!url) return undefined;
  for (let i = start + 1; i < lines.length && !looksWhole(url); i++) {
    const frag = lines[i].replace(BOX_TRIM_RE, '');
    if (!frag || !URL_FRAG_RE.test(frag)) break; // first non-fragment row ends the URL
    url += frag;
  }
  return url;
}
/** Prompts the CLI shows before it gets to the browser step, each answered by accepting the highlighted
 *  default (theme → any; login method → "Claude account with subscription", which is what a pooled
 *  account must be). Matching on the question text, not on option numbering, which is likelier to shift. */
const PROMPTS: { key: string; re: RegExp }[] = [
  { key: 'theme', re: /Choose the text style/i },
  { key: 'method', re: /Select login method/i },
];
/** The CLI rejected the pasted code — worth surfacing verbatim rather than waiting out the TTL. Matches
 *  both the older wording ("Invalid code provided") and what claude 2.1.237 prints for a bad/expired code
 *  or a code exchanged against a stale PKCE challenge: `OAuth error: Request failed with status code 400`. */
const BAD_CODE_RE = /(invalid|expired|failed).{0,30}(code|token|authoriz)/i;
/** The CLI parks on this after a rejected code and re-runs the whole flow when Enter is pressed — which
 *  mints a NEW authorize URL (new state + PKCE challenge). That is the recovery path, and also the reason
 *  a stray Enter is destructive: it re-arms silently, so any code from the link the human already opened
 *  is then guaranteed to fail. We press it deliberately and re-publish the fresh link. */
const RETRY_PROMPT_RE = /Press Enter to retry/i;
/** Rejected codes tolerated before giving up. Two is enough to cover a mistyped/half-copied paste without
 *  looping a human through a URL that some environmental problem will reject every time. */
const MAX_CODE_ATTEMPTS = 3;

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
    // A dir that already holds a login must never be reused blind: the flow would "succeed" instantly
    // against whoever signed in there, and the operator would register the wrong account without ever
    // seeing the browser step. But WHOSE login it holds decides what to do about it:
    //  · an account in the pool points at this dir → refuse, and name that account, since removing it (or
    //    picking another name) is the fix. Reachable when a dir was added BY PATH under a different label.
    //  · nothing points at it → it is an ORPHAN of an account the operator already removed, or of an
    //    attempt that died after the token landed. Refusing there was a dead end: the console had just
    //    deleted the account, so re-adding under the SAME name became impossible without ssh'ing to the
    //    box to delete a directory — the exact class of "the easy path silently doesn't work" this surface
    //    exists to remove. Move it aside instead and continue into a clean dir. Moved, never deleted: the
    //    dir also holds the transcripts of every run made under that account.
    if (fs.existsSync(path.join(dir, spec.credentialEnv.configDirFile))) {
      const owner = this.deps.accounts.list().find((a) => a.configDir && path.resolve(a.configDir) === path.resolve(dir));
      if (owner) throw new Error(`${dir} is the credential dir of the "${owner.name}" account — remove that account first, or use another name`);
      const aside = `${dir}.orphan-${Date.now()}`;
      try { fs.renameSync(dir, aside); } catch (e) {
        throw new Error(`${dir} already holds a login and could not be moved aside (${(e as Error).message}) — remove it on the box, or add it as a credential dir by path`);
      }
      this.deps.audit('runtime.account.login.orphan.archived', { runtime, name: clean, dir, movedTo: aside });
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
    const login: Login = { id, runtime, name: clean, phase: 'starting', startedAt: Date.now(), dir, tmux, answered: new Set(), codeAttempts: 0 };
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
    // "Signed in" is a credential the runtime wrote — a FILE on Linux, a Keychain item on macOS (see
    // credentialDirHasLogin). Checking only the file stranded every Mac login: the CLI printed
    // "Logged in as …" and we timed out waiting for a file the platform never writes.
    if (credentialDirHasLogin(l.runtime, l.dir)) return toState(this.finish(l));

    if (Date.now() - l.startedAt > TTL_MS) return toState(this.fail(l, 'the login timed out — start it again, or run it on the box and add the dir by path'));

    const pane = this.deps.backend.capturePane('', l.tmux);
    if (pane == null) return toState(this.fail(l, 'the login process is no longer running — start it again'));

    // A rejected code is recoverable, and used to be treated as fatal. The CLI is sitting on "Press Enter
    // to retry", which re-runs the flow and prints a NEW authorize URL — so drive that ourselves and hand
    // the human a fresh link, rather than telling them to start over while the pane quietly re-arms with a
    // challenge the link in their browser no longer matches. That mismatch is what made a second attempt
    // fail as reliably as the first.
    if (BAD_CODE_RE.test(pane)) {
      if (l.codeAttempts >= MAX_CODE_ATTEMPTS) {
        return toState(this.fail(l, `the runtime rejected ${l.codeAttempts} codes — sign in on the box with CLAUDE_CONFIG_DIR=${l.dir} claude, then add that dir by path`));
      }
      l.codeAttempts++;
      this.deps.audit('runtime.account.login.code.rejected', { runtime: l.runtime, name: l.name, attempt: l.codeAttempts });
      // Re-arm: press Enter on the retry prompt, drop the stale URL, and go back to waiting for the CLI to
      // print the next one. `answered` is reset because the retry replays the same pre-browser prompts.
      if (RETRY_PROMPT_RE.test(pane)) this.deps.backend.injectText('', l.tmux, '', true, true, 1);
      l.phase = 'starting';
      l.url = undefined;
      l.urlSeenAt = undefined;
      l.codeAt = undefined;
      l.answered = new Set();
      l.notice = 'that code was rejected — a fresh sign-in link is being prepared, open THAT one (the previous link is no longer valid)';
      return toState(l);
    }

    // The CLI parks on "Login successful. Press Enter to continue…" after a good code. The credential is
    // already stored by then, so this is only good manners — it lets the CLI exit instead of leaving a
    // pane sitting on a prompt until we kill it.
    if (/Login successful/i.test(pane) && !l.answered.has('login-done')) {
      this.deps.backend.injectText('', l.tmux, '', true, true, 1);
      l.answered.add('login-done');
      return toState(l);
    }

    // Answer each pre-browser prompt once, by accepting its highlighted default.
    for (const p of PROMPTS) {
      if (!l.answered.has(p.key) && p.re.test(pane)) {
        this.deps.backend.injectText('', l.tmux, '', true);
        l.answered.add(p.key);
        return toState(l); // one screen per poll — let the next render land before reading again
      }
    }

    const url = extractAuthorizeUrl(pane);
    if (url && l.phase === 'starting' && l.url === undefined) {
      if (looksWhole(url)) {
        l.phase = 'awaiting-code';
        l.url = url;
      } else {
        // Caught mid-render: the URL's head printed before its `state=` tail landed. Keep polling for a
        // whole one; only a URL that stays clipped past the settle window is genuinely broken. Failing on
        // the first partial capture (as this did) turned a transient read into an unrecoverable login.
        l.urlSeenAt ??= Date.now();
        if (Date.now() - l.urlSeenAt > URL_SETTLE_MS) {
          return toState(this.fail(l, 'the sign-in link came back incomplete from the runtime — start it again, or run the login on the box and add the dir by path'));
        }
      }
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
    // ONE Enter, deliberately: the backend's default double-press exists for an agent composer that can
    // swallow the first one. Here the second lands on the screen the first produced — "Press Enter to
    // retry" after a bad code — silently re-running the flow with a new PKCE challenge, so the console's
    // link and the CLI's expectation drifted apart and every later code was rejected.
    if (!this.deps.backend.injectText('', l.tmux, clean, true, true, 1)) throw new Error('could not reach the login process — start it again');
    l.phase = 'exchanging';
    l.codeAt = Date.now();
    l.notice = undefined;
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
    // On macOS "holds a login" means a Keychain item keyed by this dir's PATH — which outlives the dir.
    // Forget it too: otherwise a later login into the same path silently inherits the abandoned account,
    // and the pool would show one name while authenticating as someone else.
    try {
      if (!credentialDirHasLogin(l.runtime, l.dir)) {
        fs.rmSync(l.dir, { recursive: true, force: true });
        keychainForget(l.dir);
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
  id: l.id, runtime: l.runtime, name: l.name, phase: l.phase, url: l.url, error: l.error,
  notice: l.notice, codeAttempts: l.codeAttempts, startedAt: l.startedAt,
});

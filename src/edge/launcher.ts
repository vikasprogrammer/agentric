/**
 * The session launcher — Phase A's one privileged component (the trust root).
 *
 * The main app runs `User=vikas NoNewPrivileges=true`, so it CANNOT setuid. All uid-switching moves
 * here: a tiny daemon that runs as root (its own systemd unit) and listens on a group-gated unix
 * socket. It exposes exactly the verbs below and validates every argument — it is the only thing on
 * the box with the power to run code as another uid, so it stays small, argv-only (no shell), and
 * auditable. Policy / gate / approvals / DB / audit all stay in the unprivileged app.
 *
 * Account model (decided): systemd **DynamicUser**. Per member, a "holder" transient service
 * (`aos-member-<m>.service`, DynamicUser + StateDirectory + RuntimeDirectory + a per-member slice)
 * holds one stable uid and owns that member's home (`/var/lib/aos/<m>`) while they're active.
 * Sessions and the member's ttyd run as that uid via `systemd-run --scope --uid=<uid>` into the
 * member's slice — so a member's concurrent sessions share one uid/home/socket, and different
 * members are different uids (homes 0700 → mutually unreadable).
 *
 * This file holds BOTH the client (used by the app) and the daemon (`startLauncherDaemon`, run as a
 * separate root process). Zero-dependency: newline-delimited JSON over the socket, by hand.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ── protocol ─────────────────────────────────────────────────────────────────────
export type LauncherOp =
  | 'ping'
  | 'ensure_member'
  | 'start_session'
  | 'stop_session'
  | 'ttyd_up'
  | 'ttyd_down'
  | 'release_member';

export interface LauncherRequest {
  op: LauncherOp;
  member?: string;
  sessionId?: string;
  tmuxName?: string;
  env?: Record<string, string>;
  argv?: string[];
  port?: number;
  /** Per-session files written INTO the member's home (so the member uid can read them): the
   *  `.mcp.json` (connectors) and the company-context markdown. The daemon sets MCP_CONFIG/COMPANY_FILE. */
  files?: { mcp?: string; company?: string };
  /** Agent id (folder name) — keys the member's working copy of the agent dir. */
  agent?: string;
  /** Absolute path to the SHARED (app-owned) agent source dir. The daemon syncs it into a per-member
   *  WORKING copy under the member home (the member uid owns it, so claude can `cd` + write there) and
   *  overrides AGENT_DIR to point at the copy. */
  agentSrc?: string;
}
export interface LauncherResponse {
  ok: boolean;
  uid?: number;
  error?: string;
}

// ── validation (the security surface — exported for tests) ─────────────────────────
// The socket is already access-controlled (mode 0660, group `aos`), so the CALLER is trusted to be
// the app. These checks defend the launcher from being coerced into touching arbitrary uids/paths.
const MEMBER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;       // also a safe path segment (no `/`, no `..`)
const SESSION_RE = /^[a-z0-9]{1,32}$/i;
const TMUX_RE = /^aos-[a-z0-9]{1,32}$/i;
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;      // agent id = a folder name; safe path segment
/** env keys the app may set on a session (everything else is dropped). */
export const ENV_ALLOWLIST = new Set([
  'AOS_URL', 'SESSION', 'AGENT', 'TASK_B64', 'AOS_SECRET', 'CLAUDE_SESSION_ID',
  'UNATTENDED', 'RESIDENT', 'RESUME', 'AGENT_DIR', 'HOOK', 'MCP_CONFIG', 'COMPANY_FILE', 'PATH',
]);
const TTYD_PORT_MIN = 7700;
const TTYD_PORT_MAX = 7999;

export const validMember = (m?: string): m is string => !!m && MEMBER_RE.test(m);
export const validSessionId = (s?: string): s is string => !!s && SESSION_RE.test(s);
export const validTmuxName = (t?: string): t is string => !!t && TMUX_RE.test(t);
export const validPort = (p?: number): p is number => typeof p === 'number' && Number.isInteger(p) && p >= TTYD_PORT_MIN && p <= TTYD_PORT_MAX;

/** Keep only allowlisted env keys with string values — never trust the whole map. */
export function sanitizeEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [k, v] of Object.entries(env)) {
    if (ENV_ALLOWLIST.has(k) && typeof v === 'string' && !k.includes('\n') && !v.includes('\n')) out[k] = v;
  }
  return out;
}

/**
 * Validate the in-session command. The runner is `bash <abs script under trustedDir>`; we also allow
 * `tmux`/`ttyd` (the daemon's own tools). Nothing else — so the launcher can't be used to exec
 * arbitrary programs as another uid. Returns the validated argv or null.
 */
export function validateArgv(argv: string[] | undefined, trustedDir: string): string[] | null {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  if (argv.some((a) => typeof a !== 'string' || a.includes('\n'))) return null;
  const head = argv[0];
  const underTrusted = (p: string) => path.isAbsolute(p) && (p === trustedDir || p.startsWith(trustedDir + path.sep));
  if (head === 'bash' || head === '/bin/bash' || head === '/usr/bin/bash') {
    // `bash <script>` — the script must be an absolute path inside the trusted runner dir.
    return argv[1] && underTrusted(argv[1]) ? argv : null;
  }
  if (head === 'tmux' || head === 'ttyd') return argv;
  if (underTrusted(head)) return argv; // a direct absolute path under the trusted dir
  return null;
}

// ── client (used by the unprivileged app) ──────────────────────────────────────────
export class LauncherClient {
  constructor(private readonly socketPath: string) {}

  /** One request per connection: connect, send a line, read a line, close. */
  request(req: LauncherRequest, timeoutMs = 30_000): Promise<LauncherResponse> {
    return new Promise((resolve) => {
      const sock = net.createConnection(this.socketPath);
      let buf = '';
      let done = false;
      const finish = (r: LauncherResponse) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'launcher timeout' }), timeoutMs);
      timer.unref?.();
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          try {
            finish(JSON.parse(buf.slice(0, nl)) as LauncherResponse);
          } catch {
            finish({ ok: false, error: 'bad launcher response' });
          }
        }
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        finish({ ok: false, error: `launcher unreachable: ${e.message}` });
      });
    });
  }

  ping(): Promise<LauncherResponse> {
    return this.request({ op: 'ping' });
  }
  ensureMember(member: string): Promise<LauncherResponse> {
    return this.request({ op: 'ensure_member', member });
  }
  startSession(member: string, sessionId: string, tmuxName: string, env: Record<string, string>, argv: string[], opts?: { files?: { mcp?: string; company?: string }; agent?: string; agentSrc?: string }): Promise<LauncherResponse> {
    return this.request({ op: 'start_session', member, sessionId, tmuxName, env, argv, files: opts?.files, agent: opts?.agent, agentSrc: opts?.agentSrc });
  }
  stopSession(member: string, tmuxName: string): Promise<LauncherResponse> {
    return this.request({ op: 'stop_session', member, tmuxName });
  }
  ttydUp(member: string, port: number, env: Record<string, string> = {}): Promise<LauncherResponse> {
    return this.request({ op: 'ttyd_up', member, port, env });
  }
  ttydDown(member: string): Promise<LauncherResponse> {
    return this.request({ op: 'ttyd_down', member });
  }
  releaseMember(member: string): Promise<LauncherResponse> {
    return this.request({ op: 'release_member', member });
  }
}

// ── daemon (the privileged process) ────────────────────────────────────────────────
/** A command runner — injectable so the protocol/validation can be tested without root/systemd. */
export type Exec = (file: string, args: string[]) => string;

const realExec: Exec = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });

export interface LauncherDaemonOptions {
  socketPath: string;
  /** Absolute dir the runner scripts must live under (the repo's `terminal/`). */
  trustedDir: string;
  /** chgrp the socket to this group so the app user can connect (e.g. `aos`). */
  group?: string;
  stateRoot?: string; // default /var/lib/aos  (member homes)
  runRoot?: string;   // default /run/aos      (per-member tmux sockets)
  /** Root-only dir holding the shared company Claude creds, seeded into each member's ~/.claude (A3).
   *  Default /etc/aos/claude. Absent → seeding is skipped (sessions still spawn, just unauthenticated). */
  claudeTemplate?: string;
  /** Per-member slice resource caps (A5) so one member can't starve the box. Empty string disables a
   *  given cap. Defaults: MemoryMax=2G, CPUWeight=100, TasksMax=512. */
  sliceMemoryMax?: string;
  sliceCpuWeight?: string;
  sliceTasksMax?: string;
  exec?: Exec;        // default realExec; tests inject a fake
  /** Resolve a member holder's live (dynamic) uid; default reads systemd MainPID → /proc. Injectable for tests. */
  resolveUid?: (member: string) => number | null;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LauncherDaemon {
  private readonly exec: Exec;
  private readonly stateRoot: string;
  private readonly runRoot: string;
  private readonly trustedDir: string;
  private readonly claudeTemplate: string;
  private readonly sliceCaps: string[];
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: LauncherDaemonOptions) {
    this.exec = opts.exec ?? realExec;
    this.stateRoot = opts.stateRoot ?? '/var/lib/aos';
    this.runRoot = opts.runRoot ?? '/run/aos';
    this.trustedDir = path.resolve(opts.trustedDir);
    this.claudeTemplate = opts.claudeTemplate ?? '/etc/aos/claude';
    // Per-member slice caps — '' (or explicit empty) disables a given one.
    const memMax = opts.sliceMemoryMax ?? '2G';
    const cpuW = opts.sliceCpuWeight ?? '100';
    const tasks = opts.sliceTasksMax ?? '512';
    this.sliceCaps = [
      memMax && `MemoryMax=${memMax}`,
      cpuW && `CPUWeight=${cpuW}`,
      tasks && `TasksMax=${tasks}`,
    ].filter(Boolean) as string[];
    this.log = opts.log ?? (() => undefined);
  }

  // path helpers (all derived from the validated member id — never from client input)
  private unit(member: string): string { return `aos-member-${member}.service`; }
  private ttydUnit(member: string): string { return `aos-ttyd-${member}.service`; }
  private slice(member: string): string { return `aos-${member}.slice`; }
  private home(member: string): string { return path.join(this.stateRoot, member); }
  private runDir(member: string): string { return path.join(this.runRoot, member); }
  private sock(member: string): string { return path.join(this.runDir(member), 'tmux.sock'); }
  private claudeDir(member: string): string { return path.join(this.home(member), '.claude'); }
  private sessionsDir(member: string): string { return path.join(this.home(member), 'sessions'); }
  private agentDir(member: string, agent: string): string { return path.join(this.home(member), 'agents', agent); }

  /** Try an exec, returning stdout or '' (and the failure is surfaced via thrown-error stdout). */
  private tryExec(file: string, args: string[]): { ok: boolean; out: string; err: string } {
    try {
      return { ok: true, out: this.exec(file, args).trim(), err: '' };
    } catch (e: unknown) {
      const any = e as { stdout?: unknown; stderr?: unknown; message?: string };
      return { ok: false, out: String(any.stdout ?? '').trim(), err: String(any.stderr ?? any.message ?? e) };
    }
  }

  private isActive(unit: string): boolean {
    const r = this.tryExec('systemctl', ['is-active', unit]);
    return (r.ok ? r.out : r.out) === 'active'; // is-active prints 'active' on stdout either way
  }

  /**
   * Start the per-member holder if down, prepare its (launcher-owned) home + run dir, and return its
   * live uid. NOTE: we deliberately do NOT use systemd `StateDirectory`/`RuntimeDirectory` — with
   * DynamicUser those are unit-PRIVATE and a sibling session scope (even at the same uid) gets
   * `Permission denied` on them (verified). Instead the launcher owns the dirs: it chowns them to the
   * holder's live uid at 0700, so all of that member's session scopes can share them and no other uid
   * (including the app's `vikas`) can read them.
   */
  async ensureMember(member: string): Promise<LauncherResponse> {
    if (!validMember(member)) return { ok: false, error: 'invalid member' };
    if (!this.isActive(this.unit(member))) {
      const r = this.tryExec('systemd-run', [
        `--unit=${this.unit(member)}`,
        '--service-type=exec',
        '--property=DynamicUser=yes',
        `--slice=${this.slice(member)}`,
        '/usr/bin/sleep', 'infinity', // idle holder: its only job is to hold a stable uid while active
      ]);
      if (!r.ok) return { ok: false, error: `holder start failed: ${r.err}` };
    }
    // Resolve the holder's dynamic uid (systemd MainPID → /proc), then claim the dirs for it.
    let uid: number | null = null;
    for (let i = 0; i < 50; i++) {
      uid = this.resolveUid(member);
      if (uid !== null) break;
      await sleep(100);
    }
    if (uid === null) return { ok: false, error: 'timed out resolving member uid' };
    try {
      this.prepareDir(this.home(member), uid);
      this.prepareDir(this.runDir(member), uid);
      this.seedClaude(member, uid);
      this.applySliceCaps(member);
    } catch (e) {
      return { ok: false, error: `dir prep failed: ${String(e)}` };
    }
    return { ok: true, uid };
  }

  /** Cap the member's slice (CPU/Mem/Tasks) so one member can't starve the box (A5). Runtime drop-in
   *  (resets on reboot — fine, the slice is transient). Best-effort: never fail a launch over it. */
  private applySliceCaps(member: string): void {
    if (!this.sliceCaps.length) return;
    this.tryExec('systemctl', ['set-property', '--runtime', this.slice(member), ...this.sliceCaps]);
  }

  /**
   * Seed the shared company Claude credentials into the member's `~/.claude` once (A3). Copies the
   * root-only template (default /etc/aos/claude) into the member home, chowned to the live uid, 0700.
   * Skips if the template is absent (not configured) or the creds are already present (idempotent).
   * Per-member homes mean transcripts stay private; the Anthropic identity/bill is shared (by design —
   * prefer an API-key template over a subscription login to avoid OAuth-refresh fights).
   */
  private seedClaude(member: string, uid: number): void {
    if (!fs.existsSync(this.claudeTemplate)) return;
    const dst = this.claudeDir(member);
    if (fs.existsSync(path.join(dst, '.credentials.json'))) return; // already seeded
    this.exec('mkdir', ['-p', dst]);
    this.exec('cp', ['-a', `${this.claudeTemplate}/.`, `${dst}/`]);
    this.exec('chown', ['-R', `${uid}:${uid}`, dst]);
    this.exec('chmod', ['-R', 'go-rwx', dst]); // owner-only (dirs 700, files 600)
    this.log(`seeded ~/.claude for ${member}`);
  }

  /**
   * Write per-session files (the `.mcp.json` + company markdown) INTO the member's home so the member
   * uid can read them, and return the env additions (MCP_CONFIG/COMPANY_FILE) pointing at them.
   * Written as root then chowned to the member uid, 0600. (The app can't write the member's 0700 home.)
   */
  private writeSessionFiles(member: string, uid: number, sessionId: string, files?: { mcp?: string; company?: string }): Record<string, string> {
    const dir = this.sessionsDir(member);
    this.prepareDir(dir, uid); // mkdir + chown uid + 0700
    const extra: Record<string, string> = {};
    const put = (name: string, contents: string, envKey: string): void => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, contents, { mode: 0o600 });
      this.exec('chown', [`${uid}:${uid}`, f]);
      this.exec('chmod', ['600', f]);
      extra[envKey] = f;
    };
    if (files?.mcp) put(`${sessionId}.mcp.json`, files.mcp, 'MCP_CONFIG');
    if (files?.company) put(`${sessionId}.company.md`, files.company, 'COMPANY_FILE');
    return extra;
  }

  /**
   * Give the member their OWN working copy of the (shared, app-owned) agent dir under their home, so
   * claude can `cd` into it and write `.claude/settings.json` + scratch as the member uid — and one
   * member's agent state can't be read/clobbered by another. On first use we full-copy the source;
   * thereafter we only refresh the OS-controlled bits (CLAUDE.md + `.claude/skills`) so the member's
   * accumulated claude state/scratch survives. Returns the working dir (the new AGENT_DIR), or '' if
   * the source is invalid.
   */
  private syncAgentDir(member: string, uid: number, agent: string, src: string): string {
    if (!AGENT_RE.test(agent)) return '';
    if (!path.isAbsolute(src) || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return '';
    const work = this.agentDir(member, agent);
    const firstTime = !fs.existsSync(work);
    this.exec('mkdir', ['-p', work]);
    if (firstTime) {
      this.exec('cp', ['-a', `${src}/.`, `${work}/`]);
    } else {
      if (fs.existsSync(path.join(src, 'CLAUDE.md'))) this.exec('cp', ['-a', path.join(src, 'CLAUDE.md'), `${work}/`]);
      const srcSkills = path.join(src, '.claude', 'skills');
      if (fs.existsSync(srcSkills)) {
        this.exec('mkdir', ['-p', path.join(work, '.claude')]);
        this.exec('rm', ['-rf', path.join(work, '.claude', 'skills')]);
        this.exec('cp', ['-a', srcSkills, `${path.join(work, '.claude')}/`]);
      }
    }
    this.exec('chown', ['-R', `${uid}:${uid}`, work]);
    this.exec('chmod', ['700', work]);
    return work;
  }

  /** The member holder's live (dynamic) uid, via the injected resolver or systemd MainPID → /proc. */
  private resolveUid(member: string): number | null {
    if (this.opts.resolveUid) return this.opts.resolveUid(member);
    const r = this.tryExec('systemctl', ['show', '-p', 'MainPID', '--value', this.unit(member)]);
    const pid = parseInt(r.out, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^Uid:\s+\d+\s+(\d+)/m); // effective uid = 2nd field
      const uid = m ? parseInt(m[1], 10) : NaN;
      return Number.isInteger(uid) && uid > 0 ? uid : null;
    } catch {
      return null;
    }
  }

  /**
   * Make `dir` exist and be owned by `uid` at 0700. Re-chown only when ownership drifted (a holder
   * restart can hand the member a new dynamic uid) — so the hot path (every start_session calls
   * ensureMember) stays cheap. `chown -R` covers any files a prior uid left in the home.
   */
  private prepareDir(dir: string, uid: number): void {
    this.exec('mkdir', ['-p', dir]);
    const cur = this.tryExec('stat', ['-c', '%u', dir]).out;
    if (cur !== String(uid)) this.exec('chown', ['-R', `${uid}:${uid}`, dir]);
    this.exec('chmod', ['700', dir]);
  }

  async startSession(req: LauncherRequest): Promise<LauncherResponse> {
    const { member, tmuxName } = req;
    if (!validMember(member)) return { ok: false, error: 'invalid member' };
    if (!validSessionId(req.sessionId)) return { ok: false, error: 'invalid sessionId' };
    if (!validTmuxName(tmuxName)) return { ok: false, error: 'invalid tmux name' };
    const argv = validateArgv(req.argv, this.trustedDir);
    if (!argv) return { ok: false, error: 'command not permitted' };

    const ensured = await this.ensureMember(member);
    if (!ensured.ok || ensured.uid === undefined) return ensured;
    const uid = ensured.uid;

    // Materialise the session's .mcp.json / company file into the member home (readable by the member
    // uid) and point MCP_CONFIG/COMPANY_FILE at them — overriding any app-supplied values.
    const fileEnv = this.writeSessionFiles(member, uid, req.sessionId!, req.files);
    const env = { ...sanitizeEnv(req.env), ...fileEnv };
    // Per-member agent working copy: AGENT_DIR must be a dir the member uid owns + can write.
    if (req.agentSrc && req.agent) {
      const work = this.syncAgentDir(member, uid, req.agent, req.agentSrc);
      if (work) env.AGENT_DIR = work;
    }
    const setenv = Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
    const r = this.tryExec('systemd-run', [
      '--scope',
      `--uid=${uid}`,
      `--slice=${this.slice(member)}`,
      `--setenv=HOME=${this.home(member)}`,
      ...setenv,
      '--',
      'tmux', '-S', this.sock(member), 'new-session', '-d', '-s', tmuxName!, '-x', '203', '-y', '50',
      ...argv,
    ]);
    return r.ok ? { ok: true, uid } : { ok: false, error: `session start failed: ${r.err}` };
  }

  async stopSession(req: LauncherRequest): Promise<LauncherResponse> {
    const { member, tmuxName } = req;
    if (!validMember(member)) return { ok: false, error: 'invalid member' };
    if (!validTmuxName(tmuxName)) return { ok: false, error: 'invalid tmux name' };
    const uid = this.resolveUid(member);
    if (uid === null) return { ok: true }; // member not running → nothing to kill
    const r = this.tryExec('systemd-run', [
      '--scope', `--uid=${uid}`, `--slice=${this.slice(member)}`,
      '--', 'tmux', '-S', this.sock(member), 'kill-session', '-t', tmuxName!,
    ]);
    return r.ok ? { ok: true } : { ok: false, error: r.err };
  }

  async ttydUp(req: LauncherRequest): Promise<LauncherResponse> {
    const { member, port } = req;
    if (!validMember(member)) return { ok: false, error: 'invalid member' };
    if (!validPort(port)) return { ok: false, error: 'invalid port' };
    const ensured = await this.ensureMember(member);
    if (!ensured.ok || ensured.uid === undefined) return ensured;
    if (this.isActive(this.ttydUnit(member))) return { ok: true, uid: ensured.uid };
    const env = sanitizeEnv(req.env);
    const setenv = Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
    const r = this.tryExec('systemd-run', [
      `--unit=${this.ttydUnit(member)}`,
      '--service-type=exec',
      `--uid=${ensured.uid}`,
      `--slice=${this.slice(member)}`,
      `--setenv=HOME=${this.home(member)}`,
      ...setenv,
      '--',
      'ttyd', '-p', String(port), '-i', '127.0.0.1', '-b', `/terminal/${member}`, '-a', '-W',
      // Ping to keep the WS alive through idle proxies, and auto-reattach after a dropped socket — the
      // tmux session persists so reconnect re-attaches to the live session. See the matching rationale in
      // tenant-registry.launchTtyd: disableReconnect made a transient blip blank the terminal permanently.
      '-P', '30', '-t', 'disableReconnect=false', '-t', 'disableLeaveAlert=true', '-t', 'fontSize=14',
      'tmux', '-S', this.sock(member), 'attach', '-t',
    ]);
    return r.ok ? { ok: true, uid: ensured.uid } : { ok: false, error: `ttyd start failed: ${r.err}` };
  }

  async ttydDown(req: LauncherRequest): Promise<LauncherResponse> {
    if (!validMember(req.member)) return { ok: false, error: 'invalid member' };
    this.tryExec('systemctl', ['stop', this.ttydUnit(req.member!)]);
    this.tryExec('systemctl', ['reset-failed', this.ttydUnit(req.member!)]);
    return { ok: true };
  }

  /**
   * Stop the member's holder + ttyd → releases the uid (the home persists on disk). We then neutralize
   * the home (chown to root:root) so that when systemd later RECYCLES this dynamic uid for a different
   * member, that member can't read this one's files. The next `ensureMember` re-chowns it to the new
   * live uid, restoring access. Also drops the now-empty per-member slice.
   */
  async releaseMember(req: LauncherRequest): Promise<LauncherResponse> {
    if (!validMember(req.member)) return { ok: false, error: 'invalid member' };
    const m = req.member!;
    this.tryExec('systemctl', ['stop', this.ttydUnit(m), this.unit(m), this.slice(m)]);
    this.tryExec('systemctl', ['reset-failed', this.ttydUnit(m), this.unit(m), this.slice(m)]);
    this.tryExec('chown', ['-R', 'root:root', this.home(m)]); // close the uid-recycling window
    this.tryExec('chmod', ['700', this.home(m)]);
    this.tryExec('rm', ['-rf', this.runDir(m)]); // socket dir is ephemeral; recreated on next ensure
    return { ok: true };
  }

  private async dispatch(req: LauncherRequest): Promise<LauncherResponse> {
    switch (req.op) {
      case 'ping': return { ok: true };
      case 'ensure_member': return this.ensureMember(req.member!);
      case 'start_session': return this.startSession(req);
      case 'stop_session': return this.stopSession(req);
      case 'ttyd_up': return this.ttydUp(req);
      case 'ttyd_down': return this.ttydDown(req);
      case 'release_member': return this.releaseMember(req);
      default: return { ok: false, error: `unknown op: ${(req as { op?: string }).op}` };
    }
  }

  /** Start listening. Returns the net.Server (for tests / graceful shutdown). */
  listen(): net.Server {
    try {
      if (fs.existsSync(this.opts.socketPath)) fs.rmSync(this.opts.socketPath);
    } catch { /* best-effort */ }
    fs.mkdirSync(path.dirname(this.opts.socketPath), { recursive: true });

    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = '';
        let req: LauncherRequest;
        try {
          req = JSON.parse(line) as LauncherRequest;
        } catch {
          conn.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n');
          return;
        }
        this.dispatch(req)
          .then((resp) => { this.log(`${req.op} member=${req.member ?? '-'} → ${resp.ok ? 'ok' : 'ERR ' + resp.error}`); conn.end(JSON.stringify(resp) + '\n'); })
          .catch((e) => conn.end(JSON.stringify({ ok: false, error: String(e) }) + '\n'));
      });
      conn.on('error', () => undefined);
    });

    server.listen(this.opts.socketPath, () => {
      // Group-gate the socket so only the app user (in group `aos`) can connect.
      try {
        if (this.opts.group) this.exec('chgrp', [this.opts.group, this.opts.socketPath]);
        fs.chmodSync(this.opts.socketPath, this.opts.group ? 0o660 : 0o600);
      } catch (e) {
        this.log(`socket perms warning: ${String(e)}`);
      }
      this.log(`launcher listening on ${this.opts.socketPath} (trustedDir=${this.trustedDir})`);
    });
    return server;
  }
}

/** Entry point for the `agent-os launcher` subcommand (run as root, its own systemd unit). */
export function startLauncherDaemon(argv: string[]): void {
  const opt = (name: string, def?: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : def;
  };
  const repoTerminal = path.resolve(__dirname, '../../terminal');
  const daemon = new LauncherDaemon({
    socketPath: opt('socket', '/run/aos/launcher.sock')!,
    trustedDir: opt('trusted-dir', repoTerminal)!,
    group: opt('group', 'aos'),
    stateRoot: opt('state-root'),
    runRoot: opt('run-root'),
    claudeTemplate: opt('claude-template'),
    sliceMemoryMax: opt('slice-memory-max'),
    sliceCpuWeight: opt('slice-cpu-weight'),
    sliceTasksMax: opt('slice-tasks-max'),
    log: (m) => console.log(`[aos-launcher] ${m}`),
  });
  daemon.listen();
}

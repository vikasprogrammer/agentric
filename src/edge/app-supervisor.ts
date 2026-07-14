/**
 * The App supervisor — runs hosted apps as supervised child processes and hands the proxy a live port.
 *
 * One per tenant runtime (peer of Automations/SlackSocket). It owns the running-app table and the
 * lifecycle the manifest declares: `scale-to-zero` apps cold-start on the first proxied request and are
 * idle-killed after `idleTimeoutSec`; `resident` apps are kept warm and restarted on crash. Each app
 * runs on an ephemeral loopback port with a per-launch secret (`AOS_APP_TOKEN`) so its callbacks to
 * `/api/app/*` are authenticated the same way an agent's session-secret loopback calls are.
 *
 * This is the macOS/local path: a plain `child_process.spawn` of the Node binary. Linux uid-isolation
 * (`launcher.ts` `start_app`: DynamicUser + slice + egress-deny) lands in a follow-up behind
 * `AOS_UID_ISOLATION`; the spawn seam here is where that swaps in. See docs/apps-plan.md §3.
 */
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { AppStore } from '../state/apps';
import { AppManifest } from '../types';

export type AppStatus = 'cold' | 'starting' | 'ready' | 'crashed';

interface RunningApp {
  slug: string;
  status: AppStatus;
  proc?: ChildProcess;
  port?: number;
  secret: string;
  lastHit: number;
  startedAt: number;
  /** Consecutive crash count — drives resident restart backoff; reset once an app goes `ready`. */
  crashes: number;
  /** In-flight launch, so concurrent requests share one cold-start instead of racing spawns. */
  launching?: Promise<RunningApp>;
  lastError?: string;
}

export interface SupervisorOptions {
  /** Loopback base the app calls back into (`/api/app/*`), exported as `AOS_LOOPBACK`. */
  loopbackBase: string;
  /** Tenant id, forwarded so an app's loopback call routes to the right runtime (`x-aos-tenant`). */
  tenant: string;
  /** How long to wait for a freshly-spawned app to answer before giving up. Default 15s. */
  readyTimeoutMs?: number;
  /** Idle-sweep cadence. Default 30s. */
  sweepMs?: number;
}

export class AppSupervisor {
  private readonly running = new Map<string, RunningApp>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly readyTimeoutMs: number;
  private readonly sweepMs: number;

  constructor(
    private readonly apps: AppStore,
    private readonly opts: SupervisorOptions,
  ) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    this.sweepMs = opts.sweepMs ?? 30_000;
  }

  /** Begin the idle-sweep loop (unref'd so it never holds the process open). */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs);
    this.sweepTimer.unref?.();
  }

  /** Stop the sweep and tear down every running app (server shutdown / tenant eviction). */
  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
    for (const slug of [...this.running.keys()]) this.kill(slug, 'supervisor stop');
  }

  /** Snapshot of an app's runtime status (for the console + `/api/apps`). */
  statusOf(slug: string): { status: AppStatus; port?: number; lastError?: string; uptimeMs?: number } {
    const r = this.running.get(slug);
    if (!r) return { status: 'cold' };
    return { status: r.status, port: r.port, lastError: r.lastError, uptimeMs: r.status === 'ready' ? Date.now() - r.startedAt : undefined };
  }

  /** Verify an app's per-launch callback secret (constant-time). Backs `/api/app/*` auth. */
  verifyAppSecret(slug: string, provided: string): boolean {
    const r = this.running.get(slug);
    if (!r || !r.secret || !provided) return false;
    const a = Buffer.from(r.secret);
    const b = Buffer.from(provided);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Resolve `slug` → a live port, cold-starting the app if needed. Throws if it's absent, unpublished
   *  (unless `allowUnpublished` — the owner/admin preview path), or fails to come up. Records a hit so
   *  scale-to-zero idle timing is accurate. */
  async ensureReady(slug: string, opts: { allowUnpublished?: boolean } = {}): Promise<number> {
    const manifest = this.apps.get(slug);
    if (!manifest) throw new Error(`no such app: ${slug}`);
    if (!manifest.published && !opts.allowUnpublished) throw new Error(`app not published: ${slug}`);

    let r = this.running.get(slug);
    if (r?.status === 'ready' && r.port) { r.lastHit = Date.now(); return r.port; }
    if (r?.launching) { const done = await r.launching; done.lastHit = Date.now(); if (done.port) return done.port; throw new Error(done.lastError || 'app failed to start'); }

    const launch = this.launch(manifest);
    r = this.running.get(slug)!;
    r.launching = launch;
    try {
      const done = await launch;
      done.lastHit = Date.now();
      if (done.status === 'ready' && done.port) return done.port;
      throw new Error(done.lastError || 'app failed to start');
    } finally {
      const cur = this.running.get(slug);
      if (cur) cur.launching = undefined;
    }
  }

  /** Note a proxied request so the idle sweep doesn't reap an actively-used scale-to-zero app. */
  touch(slug: string): void {
    const r = this.running.get(slug);
    if (r) r.lastHit = Date.now();
  }

  private async launch(manifest: AppManifest): Promise<RunningApp> {
    const slug = manifest.id;
    const secret = crypto.randomBytes(24).toString('hex');
    const rec: RunningApp = { slug, status: 'starting', secret, lastHit: Date.now(), startedAt: Date.now(), crashes: this.running.get(slug)?.crashes ?? 0 };
    this.running.set(slug, rec);

    try {
      const dir = manifest.dir!;
      const entry = path.resolve(dir, manifest.entry);
      // Keep the entry inside the app folder — a manifest can't point the runner at arbitrary files.
      if (!entry.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(entry)) {
        throw new Error(`entry not found in app folder: ${manifest.entry}`);
      }
      const port = await findFreePort();
      const env = this.childEnv(manifest, port, secret);
      const proc = spawn(process.execPath, [entry], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      rec.proc = proc;
      rec.port = port;
      this.wireLogs(manifest, proc);
      this.wireExit(slug, proc);

      await this.awaitReady(port);
      const cur = this.running.get(slug);
      if (!cur || cur.proc !== proc) throw new Error('app exited during startup'); // crashed while we waited
      cur.status = 'ready';
      cur.crashes = 0;
      cur.lastError = undefined;
      return cur;
    } catch (e) {
      const cur = this.running.get(slug) ?? rec;
      cur.status = 'crashed';
      cur.lastError = e instanceof Error ? e.message : String(e);
      if (cur.proc) { try { cur.proc.kill('SIGKILL'); } catch { /* already gone */ } cur.proc = undefined; }
      cur.port = undefined;
      return cur;
    }
  }

  /** The env a hosted app process gets. Declared vault secrets are injected in the secrets increment
   *  (docs/apps-plan.md §4.1) — this is the seam. */
  private childEnv(manifest: AppManifest, port: number, secret: string): NodeJS.ProcessEnv {
    return {
      // A deliberately minimal, non-inherited env: the app gets PATH + the OS contract, not the
      // server's whole environment (no stray secrets leak in). Broaden only via declared capabilities.
      PATH: process.env.PATH,
      HOME: manifest.dir,
      PORT: String(port),
      AOS_APP_TOKEN: secret,
      AOS_APP_SLUG: manifest.id,
      AOS_APP_HOME: manifest.dir,
      AOS_LOOPBACK: this.opts.loopbackBase,
      AOS_TENANT: this.opts.tenant,
      NODE_ENV: 'production',
    };
  }

  private wireLogs(manifest: AppManifest, proc: ChildProcess): void {
    const logFile = path.join(manifest.dir!, 'app.log');
    const tag = (line: string) => `[${new Date().toISOString()}] ${line}`;
    const append = (buf: Buffer) => { try { fs.appendFileSync(logFile, buf.toString().split('\n').filter(Boolean).map(tag).join('\n') + '\n'); } catch { /* best-effort */ } };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
  }

  private wireExit(slug: string, proc: ChildProcess): void {
    proc.on('exit', (code, signal) => {
      const cur = this.running.get(slug);
      if (!cur || cur.proc !== proc) return; // superseded by a newer launch — ignore this stale exit
      cur.proc = undefined;
      cur.port = undefined;
      cur.status = 'crashed';
      cur.crashes += 1;
      cur.lastError = `exited (code=${code ?? '-'} signal=${signal ?? '-'})`;
      // Resident apps self-heal with capped backoff; scale-to-zero just goes cold until the next hit.
      const manifest = this.apps.get(slug);
      if (manifest?.lifecycle === 'resident' && manifest.published) {
        const delay = Math.min(30_000, 500 * 2 ** Math.min(cur.crashes, 6));
        setTimeout(() => { if (this.running.get(slug)?.status === 'crashed') void this.launch(manifest); }, delay).unref?.();
      }
    });
    proc.on('error', (err) => {
      const cur = this.running.get(slug);
      if (cur && cur.proc === proc) cur.lastError = err.message;
    });
  }

  /** Poll the child's port until it accepts a TCP connection or we time out. A listening socket is
   *  enough — we don't require a specific HTTP response, so any framework/route layout works. */
  private async awaitReady(port: number): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let wait = 50;
    for (;;) {
      if (await canConnect(port)) return;
      if (Date.now() >= deadline) throw new Error('timed out waiting for app to listen');
      await sleep(wait);
      wait = Math.min(500, wait * 1.5);
    }
  }

  /** Idle-reap scale-to-zero apps whose last hit is older than their timeout. */
  private sweep(): void {
    const now = Date.now();
    for (const [slug, r] of this.running) {
      if (r.status !== 'ready') continue;
      const manifest = this.apps.get(slug);
      if (!manifest || manifest.lifecycle === 'resident') continue;
      const idleMs = (manifest.idleTimeoutSec ?? 900) * 1000;
      if (now - r.lastHit > idleMs) this.kill(slug, 'idle');
    }
  }

  /** Stop an app and drop it from the table (an idle reap, an explicit stop, or shutdown). */
  kill(slug: string, _reason: string): void {
    const r = this.running.get(slug);
    if (!r) return;
    if (r.proc) { try { r.proc.kill('SIGTERM'); } catch { /* already gone */ } }
    this.running.delete(slug);
  }
}

/** Ask the OS for a free loopback port by binding to 0, then releasing it for the child to claim. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))));
    });
  });
}

/** Resolve true once a TCP connection to the loopback port succeeds. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

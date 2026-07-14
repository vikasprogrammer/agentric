/**
 * The Apps plane (`os.apps`) — the on-disk registry of hosted apps.
 *
 * An App is a folder under `<home>/apps/<slug>/`:
 *   app.json        the manifest (see {@link AppManifest})
 *   app/server.js   the Node source the supervisor runs (entry, default `app/server.js`)
 *   data.db         the app's OWN SQLite — never the agent-os DB (encapsulation; tenant boundary)
 *
 * This store owns the manifest + source lifecycle (list/get/scaffold/save/publish/remove). Actually
 * *running* an app (spawn, port, readiness, idle-kill) is the {@link AppSupervisor}'s job — the split
 * mirrors TaskStore (state) vs. the edge dispatcher (execution). Disk is the source of truth, so an
 * app dropped in by an agent writing a sibling folder, a git pull, or scp is picked up on rescan, the
 * same way agents are. No DB table yet — a manifest is a small JSON doc and the folder IS the record;
 * revisions land in a follow-up (docs/apps-plan.md §6).
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppManifest, isValidAppSlug, sanitizeAppCapabilities } from '../types';

export interface ScaffoldOptions {
  name: string;
  icon?: string;
  owner?: string;
  createdBy?: string;
  capabilities?: unknown;
}

export class AppStore {
  /** `<home>/apps` — undefined in tests/demo (no data home), which disables the plane. */
  readonly root?: string;

  constructor(appsDir?: string) {
    this.root = appsDir;
    if (this.root) fs.mkdirSync(this.root, { recursive: true });
  }

  get enabled(): boolean {
    return !!this.root;
  }

  private folder(slug: string): string {
    return path.join(this.root!, slug);
  }
  private manifestPath(slug: string): string {
    return path.join(this.folder(slug), 'app.json');
  }

  /** Every app on disk (published + proposed), sorted by name. Malformed manifests are skipped. */
  list(): AppManifest[] {
    if (!this.root || !fs.existsSync(this.root)) return [];
    const out: AppManifest[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = this.get(entry.name);
      if (m) out.push(m);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Load one app's manifest (folder-tagged), or null if absent/malformed. */
  get(slug: string): AppManifest | null {
    if (!this.root || !isValidAppSlug(slug)) return null;
    const mp = this.manifestPath(slug);
    if (!fs.existsSync(mp)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(mp, 'utf8')) as Partial<AppManifest>;
      if (!raw || raw.id !== slug) return null; // id must match the folder — the folder is the record
      return this.normalize(raw, this.folder(slug));
    } catch {
      return null;
    }
  }

  /** Coerce a raw/partial manifest into a valid one (defaults + capability sanitization). */
  private normalize(raw: Partial<AppManifest>, dir: string): AppManifest {
    return {
      id: String(raw.id),
      name: String(raw.name || raw.id),
      icon: typeof raw.icon === 'string' ? raw.icon : undefined,
      entry: typeof raw.entry === 'string' && raw.entry.trim() ? raw.entry.trim() : 'app/server.js',
      lifecycle: raw.lifecycle === 'resident' ? 'resident' : 'scale-to-zero',
      idleTimeoutSec: typeof raw.idleTimeoutSec === 'number' && raw.idleTimeoutSec > 0 ? Math.floor(raw.idleTimeoutSec) : 900,
      capabilities: sanitizeAppCapabilities(raw.capabilities),
      owner: typeof raw.owner === 'string' ? raw.owner : undefined,
      createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : undefined,
      published: raw.published === true,
      version: typeof raw.version === 'number' ? raw.version : 1,
      dir,
    };
  }

  /** Create a new proposed app: folder + manifest + a minimal base-path-aware Node template + its own
   *  data dir. Throws on a bad slug or an existing app (never clobbers). Returns the loaded manifest. */
  scaffold(slug: string, opts: ScaffoldOptions): AppManifest {
    if (!this.root) throw new Error('apps plane disabled (no data home)');
    if (!isValidAppSlug(slug)) throw new Error(`invalid app slug: ${slug}`);
    const dir = this.folder(slug);
    if (fs.existsSync(dir)) throw new Error(`app already exists: ${slug}`);
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    const manifest: AppManifest = this.normalize(
      {
        id: slug,
        name: opts.name || slug,
        icon: opts.icon,
        entry: 'app/server.js',
        lifecycle: 'scale-to-zero',
        capabilities: sanitizeAppCapabilities(opts.capabilities),
        owner: opts.owner,
        createdBy: opts.createdBy,
        published: false,
        version: 1,
      },
      dir,
    );
    this.writeManifest(manifest);
    fs.writeFileSync(path.join(dir, 'app', 'server.js'), scaffoldServerJs(manifest.name), 'utf8');
    return this.get(slug)!;
  }

  /** Persist a manifest to disk (strips the runtime-only `dir`). Used by scaffold/save/publish. */
  private writeManifest(m: AppManifest): void {
    const { dir: _dir, ...persisted } = m;
    fs.writeFileSync(this.manifestPath(m.id), JSON.stringify(persisted, null, 2) + '\n', 'utf8');
  }

  /** Apply a manifest patch (name/icon/entry/lifecycle/idle/capabilities/owner), bumping the version.
   *  Never toggles `published` (that's the governance gate — see {@link publish}). Returns the saved
   *  manifest, or null if the app is absent. */
  save(slug: string, patch: Partial<AppManifest>): AppManifest | null {
    const cur = this.get(slug);
    if (!cur) return null;
    const next: AppManifest = {
      ...cur,
      name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : cur.name,
      icon: patch.icon !== undefined ? (typeof patch.icon === 'string' ? patch.icon : undefined) : cur.icon,
      entry: typeof patch.entry === 'string' && patch.entry.trim() ? patch.entry.trim() : cur.entry,
      lifecycle: patch.lifecycle === 'resident' || patch.lifecycle === 'scale-to-zero' ? patch.lifecycle : cur.lifecycle,
      idleTimeoutSec: typeof patch.idleTimeoutSec === 'number' && patch.idleTimeoutSec > 0 ? Math.floor(patch.idleTimeoutSec) : cur.idleTimeoutSec,
      capabilities: patch.capabilities !== undefined ? sanitizeAppCapabilities(patch.capabilities) : cur.capabilities,
      owner: patch.owner !== undefined ? (typeof patch.owner === 'string' ? patch.owner : undefined) : cur.owner,
      version: (cur.version ?? 1) + 1,
    };
    this.writeManifest(next);
    return this.get(slug);
  }

  /** Flip the publish gate. Publishing makes an app routable + launchable; un-publishing parks it. */
  setPublished(slug: string, published: boolean): AppManifest | null {
    const cur = this.get(slug);
    if (!cur) return null;
    this.writeManifest({ ...cur, published, version: (cur.version ?? 1) + 1 });
    return this.get(slug);
  }

  /** Remove an app folder entirely (manifest + source + data). Returns whether it existed. */
  remove(slug: string): boolean {
    if (!this.root || !isValidAppSlug(slug)) return false;
    const dir = this.folder(slug);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

/** The starter app the scaffold writes: a zero-dependency Node server that binds `PORT`, honours the
 *  `X-Forwarded-Prefix` the proxy injects, reads the trusted `X-Aos-Member` header, and opens its own
 *  `data.db` via the built-in `node:sqlite`. This is the template an agent edits into a real app. */
function scaffoldServerJs(name: string): string {
  return `// ${name} — an Agent OS hosted app. Reached at /apps/<slug>/ through the authenticated proxy.
// The proxy strips the /apps/<slug> prefix and injects:
//   X-Forwarded-Prefix: /apps/<slug>   (use it to build absolute links back to yourself)
//   X-Aos-Member / X-Aos-Role          (the logged-in human — trusted, set by the proxy)
// Your own SQLite lives at $AOS_APP_HOME/data.db. To trigger an agent in the background, POST JSON to
// $AOS_LOOPBACK/api/app/dispatch with headers { 'x-aos-app-secret': process.env.AOS_APP_TOKEN,
// 'x-aos-tenant': process.env.AOS_TENANT } and body { slug: process.env.AOS_APP_SLUG, agent, goal,
// runAsMember: <the X-Aos-Member header>, wait?: true } — the agent must be listed in your manifest's
// capabilities.dispatchAgents (default-deny). Poll GET /api/app/dispatches?slug=... for results.
const http = require('http');

const PORT = Number(process.env.PORT) || 0;

const server = http.createServer((req, res) => {
  const prefix = req.headers['x-forwarded-prefix'] || '';
  const member = req.headers['x-aos-member'] || 'unknown';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html><meta charset="utf-8"><title>${name}</title>' +
    '<h1>${name}</h1>' +
    '<p>Hosted app is running. You are <b>' + member + '</b>.</p>' +
    '<p>Mounted at <code>' + prefix + '</code>.</p>',
  );
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  console.log('${name} listening on ' + (addr && addr.port));
});
`;
}

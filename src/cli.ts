/**
 * agent-os CLI. The `bin/agent-os` shim calls into here.
 *
 *   agent-os init [dir]            scaffold a data home (the user-owned half of an instance)
 *   agent-os serve [--port=3010]   start the web console + API (default command)
 *   agent-os invite <email> [role] create a magic-link for a teammate (role: admin|member)
 *   agent-os login-link <email>    print a fresh login link for an existing member (recovery)
 *   agent-os members               list workspace members and their roles
 *   agent-os demo                  run the scripted governance demo in the terminal
 *   agent-os help                  show this help
 */
import './preflight'; // MUST be first — fail fast on Node < 22.5 before any node:sqlite import loads.
import * as fs from 'fs';
import * as path from 'path';
import { bootstrap, startServer } from './server';
import { init } from './init';
import { loadAgentOS, readRootConfig } from './kernel';
import { controlHome, resolvePaths, resolveTenantPaths } from './home';
import { TenantStore } from './state/control';
import { reconcileTenant } from './governance/policy-reconcile';
import { Role } from './types';
import { VERSION } from './version';
import { checkDeps, checkDepUpdates, installDeps, updateNpmDep, type DepsReport } from './edge/deps';

// `node:sqlite` is stable enough to depend on but still emits an ExperimentalWarning on first
// use. Swallow just that one line so the console output stays clean; surface every other warning.
const defaultWarn = process.listeners('warning').slice();
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  for (const l of defaultWarn) l(w);
});

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'init':
      init(rest);
      break;
    case undefined:
    case 'serve': {
      const portArg = rest.find((a) => a.startsWith('--port='));
      const port = portArg ? Number(portArg.split('=')[1]) : undefined;
      startServer(port);
      break;
    }
    case 'invite':
    case 'login-link':
    case 'members':
      team(cmd, rest);
      break;
    case 'tenant':
    case 'tenants':
      tenants(rest);
      break;
    case 'policy':
      policy(rest);
      break;
    case 'deps':
      if (rest[0] === 'update') await depsUpdate(rest[1] || '');
      else await deps(false);
      break;
    case 'install-deps':
      await deps(true);
      break;
    case 'demo':
      await import('./demo');
      break;
    case 'launcher': {
      // The Phase A privileged session launcher (runs as root, its own systemd unit). It is the
      // ONLY component that can run code as another uid; the app talks to it over a group-gated
      // unix socket. See docs/phase-a-scope.md.
      const { startLauncherDaemon } = await import('./edge/launcher');
      startLauncherDaemon(rest);
      break;
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      usage();
      if (cmd && !['help', '--help', '-h'].includes(cmd)) process.exitCode = 1;
  }
}

/** Check (and optionally install) the native tools a running instance shells out to. No server needed. */
async function deps(install: boolean): Promise<void> {
  const print = (r: DepsReport): void => {
    for (const d of r.deps) {
      const mark = d.installed ? (d.updateAvailable ? '↑' : '✓') : d.required ? '✗' : '·';
      const tail = d.installed ? (d.version || d.path || '') : (d.pkg ? '(missing)' : `(missing — ${d.hint || 'install manually'})`);
      const stale = d.updateAvailable ? `  → v${d.latest} available` : '';
      const off = d.offPath ? '  (off PATH)' : '';
      console.log(`  ${mark} ${d.label.padEnd(12)} ${tail}${off}${stale}`);
    }
    console.log(r.ok ? '\nAll required dependencies are installed.' : '\nSome required dependencies are missing.');
    if (!r.ok && r.installCommand) console.log(`Install them with:\n  ${r.installCommand}`);
    else if (!r.ok) console.log('No supported package manager found — install the missing tools by hand (see hints above).');
    for (const d of r.deps.filter((x) => x.updateAvailable)) {
      console.log(`\n${d.label} is out of date (v${d.latest} available). Update it with:\n  agent-os deps update ${d.bin}`);
    }
  };

  // Freshness is best-effort — an offline box still gets its presence report.
  const annotate = (r: DepsReport): Promise<DepsReport> => checkDepUpdates(r).catch(() => r);

  if (!install) { const r = await annotate(checkDeps()); print(r); process.exitCode = r.ok ? 0 : 1; return; }

  const pre = checkDeps();
  if (pre.ok && !pre.installable.length) { console.log('All required dependencies are already installed.'); return; }
  console.log('Installing missing dependencies…\n');
  const result = await installDeps();
  for (const s of result.steps) console.log(`${s.ok ? '✓' : '✗'} ${s.cmd}${s.out ? `\n${s.out}` : ''}`);
  console.log('');
  print(await annotate(result.report));
  process.exitCode = result.ok ? 0 : 1;
}

/** `agent-os deps update <bin>` — upgrade one npm-installed dependency (today: `claude`) in place. */
async function depsUpdate(bin: string): Promise<void> {
  if (!bin) { console.log('usage: agent-os deps update <bin>   (e.g. `claude`)'); process.exitCode = 1; return; }
  console.log(`Updating ${bin}…\n`);
  const result = await updateNpmDep(bin);
  for (const s of result.steps) console.log(`${s.ok ? '✓' : '✗'} ${s.cmd}${s.out ? `\n${s.out}` : ''}`);
  const after = result.report.deps.find((d) => d.bin === bin);
  if (result.ok) console.log(`\n✓ ${after?.label || bin} is now ${after?.version || 'up to date'}.`);
  else console.log(`\n✗ ${result.error || 'update failed'}`);
  console.log('\nNote: sessions already running keep the old binary until they restart.');
  process.exitCode = result.ok ? 0 : 1;
}

/** Team management from the box (box access ≈ owner) — the secure recovery path for login. */
function team(cmd: string, rest: string[]): void {
  const os = bootstrap();
  const base = `http://127.0.0.1:${Number(process.env.PORT) || 3010}`;
  const link = (token: string) => `${base}/accept?token=${token}`;

  if (cmd === 'members') {
    const members = os.team.listMembers();
    if (!members.length) return console.log('no members yet — run `agent-os serve` once to seed the owner.');
    for (const m of members) console.log(`  ${m.role.padEnd(6)} ${m.email.padEnd(28)} ${m.status.padEnd(8)} ${m.id}`);
    return;
  }

  const email = rest[0];
  if (!email) {
    console.log(`usage: agent-os ${cmd} <email>${cmd === 'invite' ? ' [admin|member]' : ''}`);
    process.exitCode = 1;
    return;
  }

  if (cmd === 'invite') {
    const role = (rest[1] as Role) || 'member';
    if (!['owner', 'admin', 'member'].includes(role)) {
      console.log('role must be one of: admin, member');
      process.exitCode = 1;
      return;
    }
    const { member, token } = os.team.invite({ email, role });
    console.log(`invited ${member.email} as ${member.role}. Magic link (valid 7 days):\n  ${link(token)}`);
    return;
  }

  // login-link
  const issued = os.team.issueLoginLink(email);
  if (!issued) {
    console.log(`no member with email ${email} — invite them first.`);
    process.exitCode = 1;
    return;
  }
  console.log(`login link for ${issued.member.email}:\n  ${link(issued.token)}`);
}

/**
 * Tenant provisioning from the box (the superadmin path; the live API mirror is /api/admin/tenants).
 * `create` seeds the new tenant's home + DB + owner and prints a login link; the running server picks
 * the tenant up on its next restart (its registry is built at boot).
 */
function tenants(rest: string[]): void {
  const baseDir = path.resolve(__dirname, '..');
  const configPath = 'config/agent-os.config.json';
  const cfg = readRootConfig(configPath, baseDir);
  const store = new TenantStore(path.join(controlHome(baseDir, cfg), 'control.db'));
  const port = Number(process.env.PORT) || 3010;
  // Resolve the default/apex slug the SAME way TenantRegistry does (AGENT_OS_TENANT overrides the config
  // `tenant`). In process-per-tenant with an override (e.g. AGENT_OS_TENANT=initech), the apex is the
  // override, not cfg.tenant — so a stale cfg-default tenant left in the control plane must be removable,
  // and the real apex must be the one that's guarded. Comparing against cfg.tenant alone got this backwards.
  const defaultTenant = process.env.AGENT_OS_TENANT || cfg.tenant;
  const loginUrl = (slug: string, token: string): string =>
    slug === defaultTenant
      ? `http://localhost:${port}/accept?token=${token}`
      : cfg.baseDomain
        ? `https://${slug}.${cfg.baseDomain}/accept?token=${token}`
        : `http://${slug}.localhost:${port}/accept?token=${token}`;

  const sub = rest[0] || 'list';

  if (sub === 'list') {
    const ts = store.list();
    if (!ts.length) return console.log('no tenants yet — run `agent-os serve` once to seed the default.');
    for (const t of ts) console.log(`  ${t.slug.padEnd(20)} ${t.status.padEnd(9)} owner=${t.ownerEmail}`);
    return;
  }

  if (sub === 'create') {
    const slug = rest[1];
    // accept `--owner <email>` or `--owner=<email>` or a bare 3rd positional arg
    const oi = rest.indexOf('--owner');
    const ownerFlag = rest.find((a) => a.startsWith('--owner='));
    const owner = ownerFlag ? ownerFlag.split('=')[1] : oi >= 0 ? rest[oi + 1] : rest[2];
    if (!slug || !owner) {
      console.log('usage: agent-os tenant create <slug> --owner <email>');
      process.exitCode = 1;
      return;
    }
    let rec;
    try {
      rec = store.create({ slug, ownerEmail: owner });
    } catch (e) {
      console.log(`cannot create tenant: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
      return;
    }
    // Build the tenant's home + DB and seed its owner. No background services — the CLI process exits;
    // the live server brings the tenant fully online (ttyd/cron/Slack) on its next restart.
    const paths = resolveTenantPaths(baseDir, cfg, rec.slug);
    const os = loadAgentOS(configPath, baseDir, { tenant: rec.slug, paths });
    const token = os.team.bootstrapOwner(rec.ownerEmail, 'Owner');
    console.log(`created tenant "${rec.slug}" (owner ${rec.ownerEmail}).`);
    if (token) console.log(`  owner login link:\n    ${loginUrl(rec.slug, token)}`);
    console.log(`  restart the server to bring "${rec.slug}" online.`);
    return;
  }

  if (sub === 'remove') {
    const slug = rest[1];
    if (!slug) {
      console.log('usage: agent-os tenant remove <slug>');
      process.exitCode = 1;
      return;
    }
    if (slug === defaultTenant) {
      console.log('cannot remove the default tenant.');
      process.exitCode = 1;
      return;
    }
    console.log(store.remove(slug) ? `removed tenant "${slug}" (its data is left on disk).` : `no such tenant "${slug}".`);
    return;
  }

  console.log('usage: agent-os tenant <list | create <slug> --owner <email> | remove <slug>>');
  process.exitCode = 1;
}

/**
 * Policy admin from the box. `reconcile` aligns every agent's `policyContext` to the enforced ruleset id
 * (the drift the #136 warning reports) — per-tenant, or `--all` across the control plane. DRY-RUN by
 * default; writing is opt-in with `--yes`. It only rewrites agent manifests, never the policy document —
 * agents conform to the policy, never the reverse. Pure filesystem (like `tenant remove`, no server): the
 * enforced id is read straight from each tenant's resolved policy file, exactly as the runtime resolves it.
 */
function policy(rest: string[]): void {
  if (rest[0] !== 'reconcile') {
    console.log('usage: agent-os policy reconcile [--tenant <slug> | --all] [--yes]');
    process.exitCode = 1;
    return;
  }

  const baseDir = path.resolve(__dirname, '..');
  const configPath = 'config/agent-os.config.json';
  const cfg = readRootConfig(configPath, baseDir);
  const defaultTenant = process.env.AGENT_OS_TENANT || cfg.tenant;
  const store = new TenantStore(path.join(controlHome(baseDir, cfg), 'control.db'));

  const apply = rest.includes('--yes') || rest.includes('--apply');
  const dryRun = !apply; // dry-run is the default; a write is opt-in
  const flag = rest.find((a) => a.startsWith('--tenant='));
  const ti = rest.indexOf('--tenant');
  const named = flag ? flag.split('=')[1] : ti >= 0 ? rest[ti + 1] : undefined;

  let slugs: string[];
  if (rest.includes('--all')) {
    slugs = store.list().map((t) => t.slug);
    if (!slugs.includes(defaultTenant)) slugs.unshift(defaultTenant); // the apex may not be a control-plane row
  } else {
    slugs = [named || defaultTenant];
  }

  let totalChanged = 0;
  for (const slug of slugs) {
    const isDefault = slug === defaultTenant;
    const paths = isDefault ? resolvePaths(baseDir, cfg) : resolveTenantPaths(baseDir, cfg, slug);
    let enforced: unknown;
    try {
      enforced = (JSON.parse(fs.readFileSync(paths.policyFile, 'utf8')) as { id?: unknown }).id;
    } catch {
      console.log(`\n[${slug}] cannot read policy (${paths.policyFile}) — skipping`);
      continue;
    }
    if (typeof enforced !== 'string' || !enforced) {
      console.log(`\n[${slug}] policy has no string id — skipping`);
      continue;
    }

    const result = reconcileTenant(paths.userAgents, enforced, { dryRun });
    totalChanged += result.changed.length;
    console.log(`\n[${slug}] enforced=${enforced}`);
    if (!result.changed.length) {
      console.log(`  nothing to do — ${result.aligned.length} aligned, ${result.skipped.length} without policyContext`);
      continue;
    }
    const verb = dryRun ? 'would reconcile' : 'reconciled';
    for (const c of result.changed) console.log(`  ${verb}: ${c.agent}  ${c.from} → ${enforced}`);
    console.log(`  ${result.changed.length} ${verb}, ${result.aligned.length} already aligned`);
  }

  if (totalChanged) {
    console.log(
      dryRun
        ? `\n${totalChanged} manifest(s) would change. Re-run with --yes to apply, then restart the tenant(s) so agents re-register.`
        : `\nApplied to ${totalChanged} manifest(s). Restart the tenant(s) so agents re-register under the enforced id.`,
    );
  }
}

function usage(): void {
  console.log(`agent-os <command>

  init [dir]            scaffold a data home (default ./data) — your agents + policy + runtime
  serve [--port=3010]   start the web console + API (default)
  invite <email> [role] mint a magic-link to invite a teammate (role: admin | member)
  login-link <email>    print a fresh login link for an existing member (recovery)
  members               list workspace members and their roles
  deps                   check the native tools sessions need (tmux/ttyd/claude/git) + their freshness
  deps update <bin>      upgrade an npm-installed tool in place (e.g. deps update claude)
  install-deps           install the missing native tools via the box's package manager
  tenant <sub>          multi-tenant admin: list | create <slug> --owner <email> | remove <slug>
  policy reconcile      align agents' policyContext to the enforced ruleset (--tenant <slug> | --all; --yes to apply)
  demo                  run the scripted governance demo in the terminal
  launcher [--socket=…] run the privileged per-member session launcher (root; Phase A)
  version               print the software version (from package.json)
  help                  show this help

  PORT env var also sets the serve port; TTYD_PORT defaults to PORT+1.
  AGENT_OS_HOME sets the data home (default ./data) — point distinct homes + PORTs at
  separate instances to run several on one machine.`);
}

void main();

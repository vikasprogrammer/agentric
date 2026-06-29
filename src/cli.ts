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
import * as path from 'path';
import { bootstrap, startServer } from './server';
import { init } from './init';
import { loadAgentOS, readRootConfig } from './kernel';
import { controlHome, resolveTenantPaths } from './home';
import { TenantStore } from './state/control';
import { Role } from './types';

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
    case 'help':
    case '--help':
    case '-h':
    default:
      usage();
      if (cmd && !['help', '--help', '-h'].includes(cmd)) process.exitCode = 1;
  }
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
  const loginUrl = (slug: string, token: string): string =>
    slug === cfg.tenant
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
    if (slug === cfg.tenant) {
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

function usage(): void {
  console.log(`agent-os <command>

  init [dir]            scaffold a data home (default ./data) — your agents + policy + runtime
  serve [--port=3010]   start the web console + API (default)
  invite <email> [role] mint a magic-link to invite a teammate (role: admin | member)
  login-link <email>    print a fresh login link for an existing member (recovery)
  members               list workspace members and their roles
  tenant <sub>          multi-tenant admin: list | create <slug> --owner <email> | remove <slug>
  demo                  run the scripted governance demo in the terminal
  launcher [--socket=…] run the privileged per-member session launcher (root; Phase A)
  help                  show this help

  PORT env var also sets the serve port; TTYD_PORT defaults to PORT+1.
  AGENT_OS_HOME sets the data home (default ./data) — point distinct homes + PORTs at
  separate instances to run several on one machine.`);
}

void main();

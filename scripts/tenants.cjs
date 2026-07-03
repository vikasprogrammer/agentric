#!/usr/bin/env node
/*
 * tenants.cjs — manage the process-per-tenant fleet from one manifest (config/tenants.json).
 *
 * Each tenant is its own self-contained `agent-os serve` process (own home + port), supervised by
 * launchd and fronted by `tailscale serve`. This wraps the fiddly bits: generating + loading the
 * launchd plists, restarting, and mapping ports onto the node's Tailscale name. See
 * docs/process-per-tenant.md.
 *
 *   node scripts/tenants.cjs <command> [slug]
 *     list                 print the tenants in the manifest
 *     status               launchd state + /health per tenant
 *     install   [slug]     write + load a launchd plist (all tenants, or one). Skips already-loaded.
 *     uninstall [slug]     unload + remove the plist
 *     restart   [slug]     kickstart -k (rebuild first if you changed code)
 *     tailscale            map each tenant's port onto Tailscale HTTPS (443/8443/10000)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'config', 'tenants.json');
const UID = process.getuid();
const LA_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const HTTPS_PORTS = [443, 8443, 10000]; // Tailscale's three HTTPS ports
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** PATH for the launchd plist (bare under launchd): node's dir + the usual Homebrew/standard bins. */
function plistPath() {
  return [path.dirname(process.execPath), `${os.homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((d, i, a) => a.indexOf(d) === i)
    .join(':');
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`no ${path.relative(REPO, MANIFEST)} — copy config/tenants.example.json and edit it.`);
    process.exit(1);
  }
  const tenants = (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).tenants || []).filter((t) => t && t.slug);
  if (!tenants.length) { console.error('manifest has no tenants.'); process.exit(1); }
  return tenants;
}

const label = (slug) => `com.agentos.${slug}`;
const plistFile = (slug) => path.join(LA_DIR, `${label(slug)}.plist`);

function isLoaded(slug) {
  try { return execFileSync('launchctl', ['list'], { encoding: 'utf8' }).includes(label(slug)); }
  catch { return false; }
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function plistXml(t) {
  const args = ['/bin/bash', path.join(REPO, 'scripts', 'run-tenant.sh'), t.slug, expand(t.home), String(t.port), t.owner || `owner@${t.slug}.local`];
  if (t.name) args.push(t.name);
  const log = path.join(expand(t.home), 'server.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label(t.slug)}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${plistPath()}</string></dict>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

function tailscaleBin() {
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (fs.existsSync(app)) return app;
  return 'tailscale'; // fall back to PATH
}

async function main() {
  const [cmd, slug] = process.argv.slice(2);
  const tenants = loadManifest();
  const pick = slug ? tenants.filter((t) => t.slug === slug) : tenants;
  if (slug && !pick.length) { console.error(`tenant "${slug}" not in manifest.`); process.exit(1); }

  switch (cmd) {
    case 'list':
      for (const t of tenants) console.log(`  ${t.slug.padEnd(14)} :${t.port}  ${expand(t.home)}  ${t.owner || ''}`);
      break;

    case 'status':
      for (const t of tenants) {
        const h = await health(t.port);
        console.log(`  ${t.slug.padEnd(14)} launchd=${isLoaded(t.slug) ? 'up  ' : 'down'}  :${t.port} ${h ? `✓ tenant=${h.tenant}${h.name && h.name !== h.tenant ? ` (${h.name})` : ''}` : '✗ no /health'}`);
      }
      break;

    case 'install':
      fs.mkdirSync(LA_DIR, { recursive: true });
      for (const t of pick) {
        if (isLoaded(t.slug)) { console.log(`  ${t.slug}: already loaded — use \`restart ${t.slug}\` to apply changes`); continue; }
        fs.mkdirSync(expand(t.home), { recursive: true });
        fs.writeFileSync(plistFile(t.slug), plistXml(t));
        execFileSync('launchctl', ['load', '-w', plistFile(t.slug)]);
        console.log(`  ${t.slug}: installed + loaded (:${t.port})`);
      }
      break;

    case 'uninstall':
      for (const t of pick) {
        try { execFileSync('launchctl', ['unload', plistFile(t.slug)]); } catch { /* not loaded */ }
        try { fs.unlinkSync(plistFile(t.slug)); } catch { /* no plist */ }
        console.log(`  ${t.slug}: unloaded + plist removed (data left on disk)`);
      }
      break;

    case 'restart':
      for (const t of pick) {
        try { execFileSync('launchctl', ['kickstart', '-k', `gui/${UID}/${label(t.slug)}`]); console.log(`  ${t.slug}: restarted`); }
        catch { console.log(`  ${t.slug}: not loaded — run \`install ${t.slug}\` first`); }
      }
      break;

    case 'tailscale': {
      if (tenants.length > HTTPS_PORTS.length) console.log(`  note: ${tenants.length} tenants but only ${HTTPS_PORTS.length} Tailscale HTTPS ports — mapping the first ${HTTPS_PORTS.length}.`);
      const ts = tailscaleBin();
      tenants.slice(0, HTTPS_PORTS.length).forEach((t, i) => {
        const hp = t.tailscalePort || HTTPS_PORTS[i];
        console.log(`  https :${hp} ⇒ http://127.0.0.1:${t.port}  (${t.slug})`);
        execFileSync(ts, ['serve', '--bg', `--https=${hp}`, `http://127.0.0.1:${t.port}`], { stdio: 'inherit' });
      });
      break;
    }

    default:
      console.log('usage: node scripts/tenants.cjs <list|status|install|uninstall|restart|tailscale> [slug]');
      process.exit(cmd ? 1 : 0);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });

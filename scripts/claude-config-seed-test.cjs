#!/usr/bin/env node
/* First-run config seeding (terminal/seed-config.js) — the thing that keeps an unattended session from
 * parking on a prompt nobody is there to answer.
 *
 * The regression this exists for: the seed wrote `~/.claude.json` unconditionally, but claude reads
 * `.claude.json` from `$CLAUDE_CONFIG_DIR` when it's set. Account rotation sets it per session, so the
 * seed and the reader were looking at different files — and every rotated session hit the theme picker,
 * then the trust dialog, then the current upsell. It shipped because nothing tested the seed against a
 * config dir. So: assertion 1 here is "the seed lands in the file claude will read". */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { seedClaudeConfig } = require(path.join(ROOT, 'terminal/seed-config.js'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-seed-test-'));
const home = path.join(TMP, 'home');
const agentDir = path.join(TMP, 'agents', 'engineer');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
// The box's own config, as it looks after months of use: onboarding done, folders trusted, and a pile of
// "seen/dismissed" counters — the exact things a freshly-logged-in credential dir has none of.
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  fullscreenUpsellSeenCount: 3,
  effortCalloutDismissed: true,
  remoteDialogSeen: true,
  userID: 'box-user',
  oauthAccount: { accountUuid: 'box-account' },
  mcpServers: { rube: { type: 'http', url: 'https://rube.app/mcp' } },
  projects: { '/somewhere/else': { hasTrustDialogAccepted: true, mcpServers: {} } },
}, null, 2));
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('\n\x1b[1m1) The seed lands in the file claude will actually read\x1b[0m');
const configDir = path.join(TMP, 'runtime-accounts', 'claude-code', 'tools');
fs.mkdirSync(configDir, { recursive: true });
// A dir straight out of `claude login`: credentials + account identity, no UI state at all.
fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ userID: 'pool-user', oauthAccount: { accountUuid: 'pool-account' } }));
let r = seedClaudeConfig({ home, configDir, projectDir: agentDir });
assert(r.target === path.join(configDir, '.claude.json'), 'with CLAUDE_CONFIG_DIR set, the config dir is the target — NOT the home root', r.target);
const seeded = read(path.join(configDir, '.claude.json'));
assert(seeded.hasCompletedOnboarding === true, 'onboarding is marked complete (no theme picker)');
assert(seeded.projects[agentDir]?.hasTrustDialogAccepted === true, 'the agent folder is trusted (no trust dialog)');
assert(seeded.fullscreenUpsellSeenCount === 3 && seeded.effortCalloutDismissed === true && seeded.remoteDialogSeen === true,
  'every "seen/dismissed" flag the box had accumulated is inherited (no upsell prompt)');
assert(r.inherited >= 3, 'the inherit is reported', String(r.inherited));
// Home-root config untouched: seeding a rotated session must not write the box's file.
assert(read(path.join(home, '.claude.json')).projects[agentDir] === undefined, 'the box config is left alone');

console.log('\n\x1b[1m2) Inheriting never overwrites the account\x1b[0m');
assert(seeded.userID === 'pool-user' && seeded.oauthAccount.accountUuid === 'pool-account',
  'the account\'s own identity keys win over the box\'s', JSON.stringify({ u: seeded.userID, a: seeded.oauthAccount }));
assert(seeded.mcpServers === undefined, 'box-level mcpServers is not copied into an account dir');
assert(seeded.projects['/somewhere/else'] === undefined, 'nor are the box\'s other project entries');

console.log('\n\x1b[1m3) Idempotent — several sessions can launch at once\x1b[0m');
const before = fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8');
r = seedClaudeConfig({ home, configDir, projectDir: agentDir });
assert(r.changed === false, 'a second run changes nothing');
assert(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8') === before, 'and rewrites nothing');
const agent2 = path.join(TMP, 'agents', 'qa');
fs.mkdirSync(agent2, { recursive: true });
r = seedClaudeConfig({ home, configDir, projectDir: agent2 });
assert(r.changed === true && read(path.join(configDir, '.claude.json')).projects[agent2].hasTrustDialogAccepted === true,
  'but a new agent folder is trusted on ITS first launch');
assert(read(path.join(configDir, '.claude.json')).projects[agentDir].hasTrustDialogAccepted === true, 'without losing the first one');

console.log('\n\x1b[1m4) The un-rotated case still works (no config dir)\x1b[0m');
const home2 = path.join(TMP, 'home2');
fs.mkdirSync(home2, { recursive: true });
r = seedClaudeConfig({ home: home2, projectDir: agentDir });
assert(r.target === path.join(home2, '.claude.json'), 'the home root is the target when no config dir is set');
const h2 = read(path.join(home2, '.claude.json'));
assert(h2.hasCompletedOnboarding === true && h2.projects[agentDir].hasTrustDialogAccepted === true, 'onboarding + trust are seeded there');
assert(r.inherited === 0, 'and there is nothing to inherit — it IS the box config', String(r.inherited));

console.log('\n\x1b[1m5) Never throws, whatever it finds\x1b[0m');
const junkDir = path.join(TMP, 'junk');
fs.mkdirSync(junkDir, { recursive: true });
fs.writeFileSync(path.join(junkDir, '.claude.json'), '{ this is not json');
r = seedClaudeConfig({ home, configDir: junkDir, projectDir: agentDir });
assert(r.changed === true && read(path.join(junkDir, '.claude.json')).hasCompletedOnboarding === true,
  'a corrupt config is replaced rather than inherited from');
const missingDir = path.join(TMP, 'not-created-yet', 'deep');
r = seedClaudeConfig({ home, configDir: missingDir, projectDir: path.join(TMP, 'no-such-agent') });
assert(fs.existsSync(path.join(missingDir, '.claude.json')), 'a config dir that does not exist yet is created');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);

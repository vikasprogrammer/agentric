#!/usr/bin/env node
/* npm boundary — an agent's `npm install` must never reach the Agentric software checkout.
 *
 * The defect (instawp, 2026-09-10): the data home lives at `<checkout>/data`; `infra-ops` ran
 * `npm install playwright-core` in a scratch folder with no package.json, npm walked UP to the nearest
 * one — the live checkout — and rewrote its package.json + lockfile, so the next deploy refused it.
 *
 * Asserted through npm's own resolution (`npm prefix` prints the project root an install would use),
 * not by re-deriving the rule: before the boundary the prefix is the checkout, after it the home.
 * Offline, no install performed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { ensureNpmBoundary } = require(path.join(ROOT, 'dist/edge/npm-boundary.js'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 250) : ''}`));

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-npm-boundary-test-')));
const checkout = path.join(TMP, 'agent-os');
const home = path.join(checkout, 'data');
const scratch = path.join(home, 'agents', 'infra-ops', 'scratch-tsk1');
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'agent-os', version: '0.0.0' }));

const prefix = () => execFileSync('npm', ['prefix'], { cwd: scratch, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true' } }).trim();

console.log('\n\x1b[1m1) THE DEFECT: without a boundary, an install in a scratch folder targets the checkout\x1b[0m');
assert(prefix() === checkout, 'npm resolves the project root to the software checkout', prefix());

console.log('\n\x1b[1m2) the boundary stops the walk at the data home\x1b[0m');
assert(ensureNpmBoundary(home) === true, 'it writes the boundary once');
assert(prefix() === home, 'npm now resolves the project root to the data home', prefix());
const pkg = JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8'));
assert(pkg.private === true, 'private — it can never be published by accident', pkg);

console.log('\n\x1b[1m3) it never overwrites\x1b[0m');
fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name: 'my-own', private: true, dependencies: { x: '1' } }));
assert(ensureNpmBoundary(home) === false, 'an existing package.json is left alone');
assert(JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).name === 'my-own', 'and its contents survive');
assert(ensureNpmBoundary(path.join(TMP, 'fresh', 'home')) === true, 'a home that does not exist yet is created, not an error');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

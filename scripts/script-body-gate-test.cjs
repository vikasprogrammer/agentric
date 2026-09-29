#!/usr/bin/env node
/**
 * The gate classifies the BODY of a script an agent runs, not just the line that runs it.
 *
 * Regression for the instawp billing incidents (FS#3709, FS#3767): billing-ops wrote its Stripe
 * teardown into `fsNNNN-execute-stripe-teardown.sh` and ran `CONFIRM=EXECUTE bash <file>`. The gate saw
 * `bash <file>` → green, and the card detach + customer delete inside went through unreviewed. The
 * same calls typed directly matched the tenant's guardrail.
 *
 * Covers: operand parsing (pure), bounded reading (fs), the enricher consuming bodies, and the wired
 * TerminalManager.gate end to end (a destructive script is denied; its command line alone is not).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-script-body-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AOS_NO_TTYD = '1';

const { executedScripts, readExecutedScripts, stripComments } = require(path.join(ROOT, 'dist/governance/script-bodies.js'));
const { enrichArgs } = require(path.join(ROOT, 'dist/governance/enricher.js'));

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) return console.log(`  ok   ${name}`);
  failed++;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
};
const files = (cmd, cwd = '/w') => executedScripts(cmd, cwd).map((f) => path.resolve(f.cwd, f.file));

console.log('\x1b[1mOperand parsing\x1b[0m');
check('bash <file>', files('CONFIRM=EXECUTE bash fs3768-execute-stripe-teardown.sh 2>&1 | tail -40')[0] === '/w/fs3768-execute-stripe-teardown.sh');
check('./<file>', files('CONFIRM=EXECUTE ./fs3767-execute-stripe-teardown.sh')[0] === '/w/fs3767-execute-stripe-teardown.sh');
check('cd then run', files('cd /a/billing-ops && bash x.sh')[0] === '/a/billing-ops/x.sh');
check('relative cd', files('cd sub && sh ./y.sh')[0] === '/w/sub/y.sh');
check('php with -d value', files('php -d variables_order=EGPCS sdel.php customers/cus_X')[0] === '/w/sdel.php');
check('python3 file', files('python3 fix.py --apply')[0] === '/w/fix.py');
check('source / dot', files('source env.sh; . lib.sh').join(',') === '/w/env.sh,/w/lib.sh');
check('bash -lc follows the inner command', files('bash -lc "./inner.sh"')[0] === '/w/inner.sh');
check('timeout wrapper', files('timeout 60 bash long.sh')[0] === '/w/long.sh');
check('php -l / bash -n are syntax checks, not runs', files('php -l app/Http/CardController.php; bash -n x.sh; node --check a.js').length === 0);
check('python -m is not a file', files('python3 -m http.server').length === 0);
check('unresolved $VAR is skipped', files('bash "$S/x.sh"').length === 0);
check('plain commands name no script', files('ls -la; grep -n foo bar.txt; git status').length === 0);
check('comments are dropped', stripComments('# DROP TABLE x\n  // rm -rf /\necho hi') === 'echo hi');

console.log('\n\x1b[1mReading (bounded, fail-open)\x1b[0m');
const dir = path.join(HOME, 'agents', 'billing-ops');
fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(dir, 'teardown.sh'), '#!/usr/bin/env bash\n# WRITES TO STRIPE\nphp spost.php "payment_methods/pm_1/detach"\nphp sdel.php "customers/cus_X"\nbash sub/inner.sh\n');
fs.writeFileSync(path.join(dir, 'sub', 'inner.sh'), 'mysql -e "DROP TABLE users"\n');
fs.writeFileSync(path.join(dir, 'harmless.sh'), '#!/bin/sh\n# never DROP TABLE here, never rm -rf /\nls -la\n');
fs.writeFileSync(path.join(dir, 'big.sh'), 'x'.repeat(200 * 1024));
fs.writeFileSync(path.join(dir, 'bin.sh'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
const read = readExecutedScripts('CONFIRM=EXECUTE bash teardown.sh', dir);
check('reads the script', read[0] && read[0].path === path.join(dir, 'teardown.sh'));
check('follows a nested script', read.some((r) => r.path === path.join(dir, 'sub', 'inner.sh')));
check('oversized file skipped', readExecutedScripts('bash big.sh', dir).length === 0);
check('binary file skipped', readExecutedScripts('./bin.sh', dir).length === 0);
check('missing file skipped', readExecutedScripts('bash nope.sh', dir).length === 0);
check('no cwd → nothing read', readExecutedScripts('bash teardown.sh', undefined).length === 0);
const stale = path.join(dir, 'stale-tool.sh');
fs.writeFileSync(stale, 'php sdel.php customers/cus_X\n');
const old = (Date.now() - 3 * 864e5) / 1000;
fs.utimesSync(stale, old, old);
const { freshSince } = require(path.join(ROOT, 'dist/governance/script-bodies.js'));
check('a stable tool (untouched for days) is not read', readExecutedScripts('bash stale-tool.sh', dir, freshSince(Date.now())).length === 0);
check('the same tool is read once it changes', (fs.utimesSync(stale, new Date(), new Date()), readExecutedScripts('bash stale-tool.sh', dir, freshSince(Date.now())).length === 1));
check('a long run keeps its own start as the cutoff', freshSince(Date.now() - 3 * 864e5) < Date.now() - 2 * 864e5);
check('self-recursion terminates', (fs.writeFileSync(path.join(dir, 'loop.sh'), 'bash loop.sh\n'), readExecutedScripts('bash loop.sh', dir).length === 1));

console.log('\n\x1b[1mEnricher consumes the bodies\x1b[0m');
const PAT = [{ pattern: String.raw`\b(spost|sdel)\.php\b`, fact: 'stripeWrite', scope: 'shell' }];
const cmd = { tool: 'Bash', input: { command: 'CONFIRM=EXECUTE bash teardown.sh 2>&1 | tail -40' } };
const blind = enrichArgs('shell.exec', cmd, [], dir, PAT);
const seen = enrichArgs('shell.exec', cmd, [], dir, PAT, undefined, readExecutedScripts(cmd.input.command, dir));
check('without bodies the command line looks harmless', !blind.stripeWrite && !blind.destructive);
check('with bodies the custom pattern fires', seen.stripeWrite === true);
check('with bodies a nested DROP TABLE is destructive', seen.destructive === true);
check('inspected paths are recorded', Array.isArray(seen.scriptsInspected) && seen.scriptsInspected.length === 2);
const calm = enrichArgs('shell.exec', { tool: 'Bash', input: { command: 'bash harmless.sh' } }, [], dir, PAT, undefined, readExecutedScripts('bash harmless.sh', dir));
check('comments in a script do not trip destructive', calm.destructive === false);
// The noise a week of real traffic showed: every tool script cleans up `rm -rf "$tmp"`, says "delete"
// somewhere, and PHP source has `Str::truncate()`. None of that may deny a script.
fs.writeFileSync(path.join(dir, 'tool.sh'), 'out=$(mktemp -d)\ncase "$1" in delete) echo deleting prod ;; esac\nphp -r "echo Str::truncate(1);"\nrm -rf "$out"\n');
const tool = enrichArgs('shell.exec', { tool: 'Bash', input: { command: './tool.sh ssh dev1' } }, [], dir, [], undefined, readExecutedScripts('./tool.sh ssh dev1', dir));
check('a script\'s rm -rf "$var" cleanup is not destructive', tool.destructive === false);
check('generic risky keywords in a script do not set risky', tool.risky === false);
fs.writeFileSync(path.join(dir, 'trunc.sh'), 'mysql -e "TRUNCATE TABLE users"\n');
check('TRUNCATE TABLE in a script is destructive', enrichArgs('shell.exec', { tool: 'Bash', input: { command: 'bash trunc.sh' } }, [], dir, [], undefined, readExecutedScripts('bash trunc.sh', dir)).destructive === true);
const fw = enrichArgs('file.write', { tool: 'Write', input: { file_path: path.join(dir, 'a.sh'), content: 'x' } }, [], dir, PAT, undefined, read);
check('bodies are ignored for non-shell capabilities', fw.scriptsInspected === undefined && fw.stripeWrite === undefined);

// A multi-condition operator pattern (`(?=[\s\S]*A)(?=[\s\S]*B)`) is quadratic over one big blob; the
// gate is synchronous, so a large script must not turn into seconds of blocked event loop.
const bigBody = Array.from({ length: 1500 }, (_, i) => `echo "step ${i} of the report builder"`).join('\n');
const LOOK = [{ pattern: String.raw`(?=[\s\S]*(?:vite build|npm run build))(?=[\s\S]*app\.example\.com)`, fact: 'prodBuild', scope: 'shell' }];
const t0 = Date.now();
enrichArgs('shell.exec', { tool: 'Bash', input: { command: 'bash big.sh' } }, [], dir, LOOK, undefined, [{ path: '/w/big.sh', body: bigBody }]);
const ms = Date.now() - t0;
check(`a ${Math.round(bigBody.length / 1024)} KB script with a lookahead pattern classifies fast (${ms} ms)`, ms < 100);

console.log('\n\x1b[1mEnd to end — TerminalManager.gate\x1b[0m');
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'), 'https://aos.example.com');
aos.agents.set('billing-ops', { id: 'billing-ops', name: 'billing-ops', runtime: 'claude-code', dir });
const t = Date.now();
aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,headless,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('ses_sb_1', 'billing-ops', 't', 't', 'tsb1', 'running', 'automation:x', null, 1, t, t);
const gate = (command) => tm.gate('ses_sb_1', 'billing-ops', 'shell.exec', { tool: 'Bash', input: { command } }, 'test');
check('running a destructive script is denied', gate('CONFIRM=EXECUTE bash teardown.sh').decision === 'deny');
check('running a harmless script is allowed', gate('bash harmless.sh').decision === 'allow');
check('policy preview agrees with the gate', tm.policyCheck('ses_sb_1', 'billing-ops', 'shell.exec', { tool: 'Bash', input: { command: 'bash teardown.sh' } }).effect === 'deny');

tm.stopAll?.();
fs.rmSync(HOME, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall script-body gate checks passed');

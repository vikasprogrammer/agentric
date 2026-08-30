#!/usr/bin/env node
/* Output styles — the knob, the library, and the guards that exist because the CLI is silent.
 *
 * An output style is the one runtime setting whose failure mode is INVISIBLE: `claude` accepts an
 * unknown `outputStyle` name, exits 0, and runs on Default. Nothing logs, nothing warns. So three
 * things need holding down here.
 *
 *   1. PRECEDENCE — a style rides the existing RuntimeTuning chain (per-run override → agent manifest →
 *      workspace default → Default), and the agent level must be able to opt OUT of a workspace default.
 *   2. VALIDATION — because the CLI won't, this layer must: an unknown name is a 400 at the API edge,
 *      not a silent Default at launch. And a runtime with no output styles must refuse the knob rather
 *      than store a setting the console would then display as if it were in force.
 *   3. THE LIBRARY — a custom style is a file that has to reach the agent's workspace, and a
 *      hand-authored one already sitting there must not be clobbered.
 *
 * This replaces `verbosity-test.cjs`. Its adoption assertions are carried over, with the same warning
 * attached: the section it originally guarded tested SAVINGS arithmetic that was correct and still
 * meaningless (`output_tokens` is ~85% tool-call arguments, so it never contained the narration a style
 * acts on). Counts are what a row can support; effect belongs to `npm run bench:output-style`.
 *
 * Isolated home; session rows are synthesized so the counts are exact. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-output-style-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1'; // a registry-backed harness spawns a ttyd per tenant and leaks it on exit
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { resolveRuntimeTuning, sanitizeRuntimeTuning, runtimeSupports } = require(path.join(ROOT, 'dist/types.js'));
const { BUILTIN_OUTPUT_STYLES, OutputStylesStore, outputStyleAdoption, isBuiltinOutputStyle, parseStyleFrontmatter, starterOutputStyle, validOutputStyleName } =
  require(path.join(ROOT, 'dist/edge/output-styles.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));

console.log('\n\x1b[1m1) precedence — override → agent → workspace → Default\x1b[0m');
assert(resolveRuntimeTuning({}, {}).outputStyle === 'Default', 'unset everywhere resolves to Default');
assert(resolveRuntimeTuning({}, { outputStyle: 'Concise' }).outputStyle === 'Concise', 'a workspace default reaches an agent that sets nothing');
assert(resolveRuntimeTuning({ outputStyle: 'Default' }, { outputStyle: 'Concise' }).outputStyle === 'Default',
  'an agent can opt OUT of a workspace default');
assert(resolveRuntimeTuning({ outputStyle: 'Default' }, { outputStyle: 'Default' }, { outputStyle: 'Proactive' }).outputStyle === 'Proactive',
  'a per-run override beats agent + workspace');
{
  // A model pinned for another runtime is dropped by resolve — that must not take the style with it.
  const r = resolveRuntimeTuning({ model: 'claude-opus-4-8', outputStyle: 'Concise' }, {}, undefined, 'claude-code');
  assert(r.model === 'claude-opus-4-8' && r.outputStyle === 'Concise', 'survives alongside a same-runtime model');
}
{
  // A workspace default spans every runtime, and codex/opencode have no output styles at all. Inheriting
  // one there would have the console showing a style that is not in force anywhere.
  assert(runtimeSupports('claude-code', 'outputStyle'), 'claude-code supports output styles');
  assert(!runtimeSupports('codex', 'outputStyle') && !runtimeSupports('opencode', 'outputStyle'), 'codex + opencode do not');
  assert(resolveRuntimeTuning({}, { outputStyle: 'Concise' }, undefined, 'codex').outputStyle === undefined,
    'an inherited style is dropped on a runtime that has none');
}

console.log('\n\x1b[1m2) sanitize — the ONLY place a typo is caught\x1b[0m');
const KNOWN = { styles: ['Default', 'Concise', 'Proactive', 'Housevoice'] };
assert(sanitizeRuntimeTuning({ outputStyle: 'Concise' }, undefined, KNOWN).tuning.outputStyle === 'Concise', 'accepts a known built-in');
assert(sanitizeRuntimeTuning({ outputStyle: 'Housevoice' }, undefined, KNOWN).tuning.outputStyle === 'Housevoice', 'accepts a library style');
assert(sanitizeRuntimeTuning({ outputStyle: 'Default' }, undefined, KNOWN).tuning.outputStyle === 'Default',
  'keeps an explicit Default (the only per-agent opt-out)');
{
  const r = sanitizeRuntimeTuning({ outputStyle: '' }, undefined, KNOWN);
  assert(!r.error && r.tuning.outputStyle === undefined, 'empty string = inherit, not an error');
}
// The whole reason this validation exists: claude runs an unknown style as Default, exit 0, no warning.
assert(/unknown output style/.test(sanitizeRuntimeTuning({ outputStyle: 'Concice' }, undefined, KNOWN).error || ''),
  'rejects a name the box does not have (the CLI would silently ignore it)');
assert(/not a valid style name/.test(sanitizeRuntimeTuning({ outputStyle: '../../etc/passwd' }, undefined, KNOWN).error || ''),
  'rejects a name that is not a style name at all');
assert(!sanitizeRuntimeTuning({ outputStyle: 7 }, undefined, KNOWN).error, 'a non-string is ignored, not fatal');
assert(/has no output styles/.test(sanitizeRuntimeTuning({ outputStyle: 'Concise' }, 'codex', KNOWN).error || ''),
  'refuses the knob on a runtime that cannot honour it');
{
  // Without an allowlist (config-file load, demo) the format check still holds — it just cannot know
  // which names exist.
  const r = sanitizeRuntimeTuning({ outputStyle: 'Whatever' });
  assert(!r.error && r.tuning.outputStyle === 'Whatever', 'no allowlist ⇒ format-check only');
}

console.log('\n\x1b[1m3) built-ins\x1b[0m');
assert(BUILTIN_OUTPUT_STYLES[0].name === 'Default', 'Default leads the list');
for (const n of ['Concise', 'Proactive', 'Explanatory', 'Learning']) assert(isBuiltinOutputStyle(n), `${n} is a built-in`);
assert(!isBuiltinOutputStyle('Housevoice'), 'a workspace style is not a built-in');
// Concise post-dates most of the fleet's binaries; a box that is behind must be told, not guessed at.
assert(BUILTIN_OUTPUT_STYLES.find((b) => b.name === 'Concise').minVersion.join('.') === '2.1.237', 'Concise declares its version floor');

console.log('\n\x1b[1m4) the library\x1b[0m');
const store = new OutputStylesStore(path.join(HOME, 'output-styles'));
assert(validOutputStyleName('House Voice') && !validOutputStyleName('../x') && !validOutputStyleName('a/b'), 'name validation refuses a path');
{
  const saved = store.save('Housevoice', starterOutputStyle('Housevoice', 'the house voice'));
  assert(saved.name === 'Housevoice' && saved.description === 'the house voice', 'save round-trips through frontmatter');
  // The frontmatter default is FALSE, which silently removes Claude Code's software-engineering
  // instructions. The starter must not ship that trap.
  assert(saved.keepCodingInstructions === true, 'the starter keeps the coding instructions');
  assert(parseStyleFrontmatter(saved.content)['keep-coding-instructions'] === 'true', 'and says so in the frontmatter');
}
{
  let err = '';
  try { store.save('Concise', 'x'); } catch (e) { err = String(e.message); }
  assert(/built-in/.test(err), 'refuses to shadow a built-in name');
}
assert(store.names().includes('Housevoice') && store.names().includes('Concise'), 'names() = built-ins + library (the sanitize allowlist)');
{
  const saved = store.save('Bare', '---\nname: Bare\ndescription: no flag\n---\n\nbody\n');
  assert(saved.keepCodingInstructions === false, 'a style that omits the flag reads as false (so the console can warn)');
}

console.log('\n\x1b[1m5) materialisation into an agent workspace\x1b[0m');
const agentClaude = path.join(HOME, 'agents', 'writer', '.claude');
{
  const names = store.materialize(agentClaude);
  assert(names.sort().join(',') === 'Bare,Housevoice', 'copies the whole library (only the selected one applies)');
  assert(fs.existsSync(path.join(agentClaude, 'output-styles', 'Housevoice.md')), 'lands at .claude/output-styles/<Name>.md');
}
{
  // An agent's own hand-authored style must survive a re-materialise — same contract as the skills
  // library, and the reason the marker file exists.
  fs.writeFileSync(path.join(agentClaude, 'output-styles', 'Mine.md'), '---\nname: Mine\n---\nlocal\n');
  store.materialize(agentClaude);
  assert(fs.readFileSync(path.join(agentClaude, 'output-styles', 'Mine.md'), 'utf8').includes('local'), 'a hand-authored style is left alone');
}
{
  // …but one this store wrote and that has since left the library is removed, or an agent keeps
  // selecting a style the workspace has deleted.
  store.remove('Bare');
  store.materialize(agentClaude);
  assert(!fs.existsSync(path.join(agentClaude, 'output-styles', 'Bare.md')), 'a deleted library style is swept from the agent');
  assert(fs.existsSync(path.join(agentClaude, 'output-styles', 'Housevoice.md')), 'and the rest stay');
}
assert(new OutputStylesStore().list().length === 0 && !new OutputStylesStore().enabled, 'no data home ⇒ an inert, empty library');

console.log('\n\x1b[1m6) the launcher wiring\x1b[0m');
// A style is not a CLI flag — it reaches claude ONLY through the settings file the launcher writes. If
// this wiring is dropped the knob keeps saving, keeps showing in the console, and does nothing at all.
{
  const { execFileSync } = require('child_process');
  const launcher = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');
  assert(/\$OUTPUT_STYLE_LINE/.test(launcher) && /outputStyle/.test(launcher), "the launcher emits an outputStyle key");
  assert(launcher.indexOf('$OUTPUT_STYLE_LINE') > launcher.indexOf('cat > .claude/aos-settings.json') - 400,
    'and emits it into the --settings file claude actually reads');
  // Run the fragment under /bin/bash (3.2 on macOS) — the launcher targets bash 3.2 + BSD userland, and a
  // bashism that only works on the Linux box would pass review and kill every Mac session.
  const frag = launcher.slice(launcher.indexOf('# OUTPUT STYLE'), launcher.indexOf('cat > .claude/aos-settings.json'));
  const run = (env) => execFileSync('/bin/bash', ['-c', `set -u; ${frag}\nprintf '%s' "$OUTPUT_STYLE_LINE"`], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert(run({ CLAUDE_OUTPUT_STYLE: 'Concise' }).includes('"outputStyle": "Concise"'), 'renders the selected style');
  assert(run({ CLAUDE_OUTPUT_STYLE: '' }) === '', 'renders NOTHING when unset (so a lower settings layer is untouched)');
  // Defence in depth behind the API-edge allowlist: a hand-set env var must never break the JSON.
  assert(!/["\\]/.test(run({ CLAUDE_OUTPUT_STYLE: 'Bad"; rm -rf /' }).replace(/"outputStyle": "|",$/g, '')), 'strips anything that could break the JSON');
  const rendered = `{\n${run({ CLAUDE_OUTPUT_STYLE: 'House Voice' })}\n  "crossSessionInbound": "refuse"\n}`;
  assert(JSON.parse(rendered).outputStyle === 'House Voice', 'and the settings file stays valid JSON');
  // The other half of the wire: the launch path has to EXPORT the var the launcher reads, and only on
  // the claude lane (codex/opencode would ignore it, and resolve drops the style for them anyway).
  const launch = fs.readFileSync(path.join(ROOT, 'dist/terminal.js'), 'utf8');
  assert(/CLAUDE_OUTPUT_STYLE\s*=\s*tuning\.outputStyle/.test(launch), 'the launch path exports CLAUDE_OUTPUT_STYLE from the resolved tuning');
  assert(/tuning\.outputStyle !== 'Default'/.test(launch), "and skips it for Default (naming it would be a no-op that shadows a lower layer)");
}

const aos = loadAgentOS();
const db = aos.db;

console.log('\n\x1b[1m7) migration\x1b[0m');
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
assert(cols('term_sessions').includes('output_style'), 'term_sessions.output_style exists (the adoption join key)');
assert(cols('agent_revisions').includes('output_style'), 'agent_revisions.output_style exists (so a revert restores it)');

console.log('\n\x1b[1m8) adoption — counts, and only counts\x1b[0m');
// Inherited wholesale from the retired verbosity panel, warning included: the section this replaced
// tested per-turn savings arithmetic that was correct and still measured the wrong quantity. A count of
// rows is a claim the data supports; a saving is not.
const DAY = 86_400_000;
let n = 0;
const mkRun = (agent, style, ageDays = 1) => {
  const id = 'ts_' + (++n), at = Date.now() - ageDays * DAY;
  db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,created_at,updated_at,turns,output_tokens,cost_usd,output_style)
              VALUES (?,?,'t','x',?,'done',?,?,10,10000,1.0,?)`)
    .run(id, agent, 'aos-' + id, at, at + 60_000, style);
};
const agentRow = (agent, days = 30) => outputStyleAdoption(db, days).byAgent.find((a) => a.agent === agent);
const countFor = (row, style) => (row ? (row.styles.find((s) => s.style === style)?.count ?? 0) : 0);

for (let i = 0; i < 6; i++) mkRun('alpha', 'Default');
for (let i = 0; i < 4; i++) mkRun('alpha', 'Concise');
for (let i = 0; i < 9; i++) mkRun('beta', 'Concise');
{
  const a = agentRow('alpha');
  assert(countFor(a, 'Default') === 6 && countFor(a, 'Concise') === 4, 'counts each style per agent');
  const byStyle = outputStyleAdoption(db).sessions.byStyle;
  const total = (s) => byStyle.find((x) => x.style === s)?.count ?? 0;
  assert(total('Concise') === 13 && total('Default') === 6, 'workspace totals sum every agent');
  assert(byStyle[0].style === 'Concise', 'styles are ranked by run count');
}
assert(countFor(agentRow('beta'), 'Concise') === 9 && agentRow('beta').styles.length === 1, 'a single-style agent is still listed');
// alpha ran 10 (6 Default + 4 Concise), beta 9 — busiest agent first, regardless of which style.
assert(outputStyleAdoption(db).byAgent[0].agent === 'alpha', 'agents ordered by TOTAL runs, busiest first');
{
  // Rows from before the knob — and every run on codex/opencode, which have no styles — are
  // attributable to no style. They get their own bucket rather than being folded into Default, so the
  // panel cannot overstate how far a style has spread.
  for (let i = 0; i < 5; i++) mkRun('alpha', null);
  const s = outputStyleAdoption(db).sessions;
  assert(s.unstamped === 5, 'un-stamped rows are their own bucket');
  assert(countFor(agentRow('alpha'), 'Default') === 6, 'and they do not reach byAgent');
}
{
  // Cost is not read at all, so a live, unpriced row is ordinary adoption data.
  db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,created_at,updated_at,turns,output_tokens,cost_usd,output_style)
              VALUES ('ts_live','alpha','t','x','aos-live','running',?,?,5,5000,NULL,'Concise')`).run(Date.now(), Date.now());
  assert(countFor(agentRow('alpha'), 'Concise') === 5, 'a running, uncosted run counts — adoption does not wait on a price');
}
for (let i = 0; i < 10; i++) mkRun('epsilon', 'Concise', 90);
assert(!agentRow('epsilon', 30), 'the trailing window excludes older runs');
assert(!!agentRow('epsilon', 120), 'and a wider window finds them again');

console.log('\n\x1b[1m9) the library over the real routes\x1b[0m');
(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const runtime = registry.default().os;
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = runtime.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${runtime.team.createSession(owner.id)}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  {
    const r = await call('GET', '/api/output-styles');
    assert(r.status === 200 && r.body.builtin.some((b) => b.name === 'Concise'), 'GET lists the built-ins for the picker');
  }
  {
    // No `content` ⇒ the server seeds the starter, which is the path a console "Create" takes. It must
    // arrive with `keep-coding-instructions: true` or a coding agent silently loses its SWE instructions.
    const r = await call('PUT', '/api/output-styles/Housevoice', { description: 'the house voice' });
    assert(r.status === 200 && r.body.keepCodingInstructions === true, 'PUT with no content seeds a safe starter');
    assert(!r.body.warning, 'and warns about nothing');
  }
  {
    const r = await call('PUT', '/api/output-styles/Risky', { content: '---\nname: Risky\ndescription: d\n---\n\nbody\n' });
    assert(/software-engineering instructions/.test(r.body.warning || ''), 'PUT warns when the coding instructions are dropped');
  }
  assert((await call('PUT', '/api/output-styles/Concise', { content: 'x' })).status === 400, 'a built-in name cannot be shadowed');
  assert((await call('GET', '/api/output-styles/Nope')).status === 404, 'an unknown style is a 404, not an empty 200');
  {
    // The whole point of the allowlist: the CLI would take this name and silently run Default.
    const target = [...runtime.agents.values()].find((a) => a.runtime === 'claude-code' && a.dir);
    if (target) {
      const bad = await call('PUT', `/api/agents/${target.id}/config`, { outputStyle: 'Housevoise' });
      assert(bad.status === 400 && /unknown output style/.test(bad.body.error || ''), 'a typo is rejected at the agent-config route');
      const good = await call('PUT', `/api/agents/${target.id}/config`, { outputStyle: 'Housevoice' });
      assert(good.status === 200 && good.body.outputStyle === 'Housevoice', 'and the real library style is accepted');
      // Deleting a style leaves its name pinned on the agent, where the CLI ignores it in silence. The
      // route names who is affected so that is recoverable rather than mysterious.
      const del = await call('DELETE', '/api/output-styles/Housevoice');
      assert(del.status === 200 && del.body.orphaned.includes(target.id), 'DELETE reports the agents left pointing at it');
    } else {
      console.log('  (no claude-code agent in a fresh home — agent-config cases skipped)');
    }
  }

  server.close();
  registry.stopAll();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
/* Partial runtime-tuning edits — an omitted knob must be KEPT, not cleared.
 *
 * The agent-config route replaced the tuning fields wholesale while every other field on it patched by
 * presence. So a one-knob save (`{verbosity:'terse'}` from a script, or any future partial caller) blanked
 * the rest: it unpinned the agent's model and dropped it onto the fleet default, with nothing in the
 * response saying so. Hit the live northwind consolidator, which is pinned to opus and quietly wasn't.
 *
 * The contract now: absent key → keep; present key → replace; `''` → clear to inherit. That last one is
 * why the console must state every knob it owns — JSON.stringify drops `undefined`, so a spread of a
 * cleared RuntimeTuning transmits nothing and would read as "don't touch". Both halves are tested here:
 * the pure merge, and the real HTTP route end to end.  */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-tuning-patch-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`));

const { runtimeTuningPatch, sanitizeRuntimeTuning } = require(path.join(ROOT, 'dist/types.js'));

console.log('\n\x1b[1m1) the merge — absent keeps, present replaces, empty clears\x1b[0m');
const CURRENT = { model: 'opus', effort: 'high', permissionMode: 'auto', verbosity: 'terse' };
{
  // THE BUG: a body carrying one knob must not blank the other three.
  const p = runtimeTuningPatch({ verbosity: 'terse' }, { model: 'opus' });
  assert(p.model === 'opus', 'a one-knob body keeps the pinned model', p);
}
{
  const p = runtimeTuningPatch({}, CURRENT);
  assert(p.model === 'opus' && p.effort === 'high' && p.permissionMode === 'auto' && p.verbosity === 'terse',
    'an empty body changes nothing', p);
}
{
  const p = runtimeTuningPatch({ model: 'sonnet' }, CURRENT);
  assert(p.model === 'sonnet' && p.effort === 'high', 'a present key replaces, its neighbours survive', p);
}
{
  // "Clear to inherit" is explicit now: send '' (an omitted key can no longer mean clear).
  const p = runtimeTuningPatch({ model: '' }, CURRENT);
  assert(p.model === '' && sanitizeRuntimeTuning(p).tuning.model === undefined, "'' clears the knob to inherit", p);
  assert(sanitizeRuntimeTuning(p).tuning.effort === 'high', 'and only that knob', p);
}
{
  const p = runtimeTuningPatch({ model: null }, CURRENT);
  assert(sanitizeRuntimeTuning(p).tuning.model === undefined, 'null clears it too', p);
}

console.log('\n\x1b[1m2) field allowlist — an agent cannot set its own permission mode\x1b[0m');
{
  const p = runtimeTuningPatch({ permissionMode: 'bypassPermissions', verbosity: 'terse' }, CURRENT,
    { fields: ['model', 'effort', 'verbosity'] });
  assert(!('permissionMode' in p), 'permissionMode is not patchable on the self-edit path', p);
  assert(p.verbosity === 'terse' && p.model === 'opus', 'the allowed knobs still patch normally', p);
}

console.log('\n\x1b[1m3) runtime switch — a foreign model is dropped, not carried into an error\x1b[0m');
{
  const p = runtimeTuningPatch({ verbosity: 'terse' }, { model: 'claude-opus-4-8', effort: 'high' }, { dropModel: true });
  assert(!('model' in p), 'switching runtime drops a model the body did not re-state', p);
  assert(p.effort === 'high', 'the other knobs still carry across the switch', p);
  assert(!sanitizeRuntimeTuning(p, 'codex').error, 'so the switch validates cleanly', sanitizeRuntimeTuning(p, 'codex'));
}
{
  const p = runtimeTuningPatch({ model: 'gpt-5-codex' }, { model: 'claude-opus-4-8' }, { dropModel: true });
  assert(p.model === 'gpt-5-codex', 'an explicitly re-stated model wins over the drop', p);
}

console.log('\n\x1b[1m4) end to end over the real route\x1b[0m');
(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const aos = registry.default().os;
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const target = [...aos.agents.values()].find((a) => a.runtime === 'claude-code' && a.dir);
  if (!target) {
    console.log('  (no claude-code agent in a fresh home — route case skipped)');
  } else {
    const id = target.id;
    const cfg = () => call('GET', `/api/agents/${id}/config`).then((r) => r.body);
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(target.dir, 'agent.json'), 'utf8'));

    await call('PUT', `/api/agents/${id}/config`, { model: 'opus', effort: 'high' });
    assert((await cfg()).model === 'opus', 'seed: model pinned to opus');

    // The exact live regression.
    await call('PUT', `/api/agents/${id}/config`, { verbosity: 'terse' });
    const after = await cfg();
    assert(after.verbosity === 'terse', 'the one knob in the body is applied', after);
    assert(after.model === 'opus', 'and the pinned model SURVIVES a one-knob save', after);
    assert(after.effort === 'high', 'as does effort', after);
    assert(onDisk().model === 'opus', 'agent.json still carries it', onDisk());

    // Clearing still works, and stays surgical.
    await call('PUT', `/api/agents/${id}/config`, { model: '' });
    const cleared = await cfg();
    assert(!cleared.model, "an explicit '' clears the model", cleared);
    assert(cleared.effort === 'high' && cleared.verbosity === 'terse', 'without touching its neighbours', cleared);

    // A tuning-only save must not disturb the non-tuning fields either (unchanged behaviour, regression-guarded).
    await call('PUT', `/api/agents/${id}/config`, { description: 'patched description' });
    const desc = await cfg();
    assert(desc.description === 'patched description' && desc.verbosity === 'terse',
      'a description-only save leaves tuning alone', desc);
  }

  server.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });

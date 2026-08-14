#!/usr/bin/env node
/**
 * Skill EDIT proposals — the falsifier for `skill_propose` on a name that already exists.
 *
 * The whole safety story of a proposed skill edit is one sentence: **the live skill does not change
 * until a human applies it.** That's easy to say and easy to break, because the obvious place to park
 * a proposal — a marker file inside the skill folder — is copied straight into every agent by
 * `copySkill` (it `cpSync`s the whole folder). So the proposed text lives OUTSIDE the folder, and this
 * test pins that: after a proposal, a materialise must still hand agents the OLD text, byte for byte,
 * and must not leak the proposal file at all.
 *
 * Also pinned:
 *   - proposing on a new name still creates (create-or-update is a branch, not a replacement),
 *   - one pending edit per skill: the same agent replaces its own, a different agent is REFUSED
 *     (clobbering a teammate's un-reviewed draft is the failure mode `agent_get`/`agent_propose_update`
 *     already taught us),
 *   - refining your OWN unpublished draft rewrites in place (nothing live ⇒ nothing to gate),
 *   - a body with no frontmatter inherits the CURRENT description (an edit to the steps must not blank
 *     what agents match on),
 *   - apply overwrites SKILL.md and clears the proposal; discard leaves the live skill untouched,
 *   - deleting a skill drops its parked edit.
 *
 *   npm run build && node scripts/skill-edit-proposal-test.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SkillsStore } = require(path.resolve(__dirname, '..', 'dist/governance/skills'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skill-edit-'));
const dir = path.join(home, 'skills');
fs.mkdirSync(dir, { recursive: true });
const store = new SkillsStore(dir);

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };
const threw = (fn) => { try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); } };

// ── create still creates ─────────────────────────────────────────────────────
store.create({ name: 'wp-version-upgrade', description: 'Upgrade a WordPress site safely.', content: '---\nname: wp-version-upgrade\ndescription: Upgrade a WordPress site safely.\n---\n\n1. Back up.\n2. Upgrade.\n' });
const live = store.get('wp-version-upgrade');
check('a plain create lands a published skill', !!live && !live.proposed && !live.pending);

// ── an edit proposal does NOT touch the live skill ────────────────────────────
const r1 = store.proposeEdit({ name: 'wp-version-upgrade', body: '1. Back up.\n2. Check PHP.\n3. Upgrade.', agent: 'wp-agent', session: 's1', rationale: 'PHP check was missing' });
check('proposeEdit on a live skill parks it (does not apply)', r1.applied === false);
check('the live SKILL.md is byte-identical after a proposal', store.get('wp-version-upgrade').content === live.content);
check('the skill reports a pending edit', !!store.get('wp-version-upgrade').pending);
check('the pending edit names its proposer', store.get('wp-version-upgrade').pending.agent === 'wp-agent');
check('the proposed text is readable for review', (store.get('wp-version-upgrade').pendingContent || '').includes('Check PHP'));

// The list payload carries the metadata but never the proposed body (payload-size discipline).
const listed = store.list().find((s) => s.name === 'wp-version-upgrade');
check('a list summary carries pending metadata', !!listed.pending && listed.pending.bytes > 0);
check('a list summary does NOT carry the proposed body', listed.pendingContent === undefined && listed.content === undefined);

// ── the proposal must not reach agents (the whole point) ─────────────────────
const agentHome = path.join(home, 'agent', '.claude');
store.materialize(agentHome, 'wp-agent');
const shipped = fs.readFileSync(path.join(agentHome, 'skills', 'wp-version-upgrade', 'SKILL.md'), 'utf8');
check('a materialised agent still gets the LIVE text', shipped === live.content);
check('the proposed text never reaches the agent', !shipped.includes('Check PHP'));
const shippedFiles = fs.readdirSync(path.join(agentHome, 'skills', 'wp-version-upgrade'));
check('no proposal file is copied into the agent', !shippedFiles.some((f) => f.includes('proposed')));
check('the parked edit lives outside the skill folder', !fs.readdirSync(path.join(dir, 'wp-version-upgrade')).some((f) => f.includes('proposed')));

// ── one pending edit per skill ───────────────────────────────────────────────
const sameAgain = threw(() => store.proposeEdit({ name: 'wp-version-upgrade', body: '1. Back up.\n2. Check PHP 8.\n3. Upgrade.', agent: 'wp-agent' }));
check('the same agent may replace its own pending edit', sameAgain === '');
check('...and the replacement is what is parked', (store.get('wp-version-upgrade').pendingContent || '').includes('PHP 8'));
const other = threw(() => store.proposeEdit({ name: 'wp-version-upgrade', body: 'something else entirely', agent: 'other-agent' }));
check('a DIFFERENT agent is refused rather than clobbering it', /already awaiting review/.test(other));
check('...and the first agent\'s edit survives the refusal', (store.get('wp-version-upgrade').pendingContent || '').includes('PHP 8'));

// ── description is inherited when the body has no frontmatter ────────────────
check('an edit without frontmatter keeps the current description', (store.get('wp-version-upgrade').pendingContent || '').includes('Upgrade a WordPress site safely.'));

// ── unknown skill / empty body ───────────────────────────────────────────────
check('proposing an edit to an unknown skill fails', /not found/.test(threw(() => store.proposeEdit({ name: 'no-such-skill', body: 'x', agent: 'a' }))));
check('an empty body fails', /body is required/.test(threw(() => store.proposeEdit({ name: 'wp-version-upgrade', body: '   ', agent: 'wp-agent' }))));

// ── apply is the human's act ─────────────────────────────────────────────────
const applied = store.applyEdit('wp-version-upgrade');
check('apply reports the proposing agent (for same-session delivery)', applied && applied.agent === 'wp-agent');
check('apply writes the proposed text to the live skill', store.get('wp-version-upgrade').content.includes('PHP 8'));
check('apply clears the pending edit', !store.get('wp-version-upgrade').pending);
check('applying twice is a no-op', store.applyEdit('wp-version-upgrade') === undefined);
store.materialize(agentHome, 'wp-agent');
check('the agent gets the new text after apply', fs.readFileSync(path.join(agentHome, 'skills', 'wp-version-upgrade', 'SKILL.md'), 'utf8').includes('PHP 8'));

// ── discard leaves the live skill alone ──────────────────────────────────────
const beforeDiscard = store.get('wp-version-upgrade').content;
store.proposeEdit({ name: 'wp-version-upgrade', body: 'rewrite everything', agent: 'wp-agent' });
check('discard removes the proposal', store.discardEdit('wp-version-upgrade') === true);
check('discard leaves the live skill untouched', store.get('wp-version-upgrade').content === beforeDiscard);
check('discarding nothing is false', store.discardEdit('wp-version-upgrade') === false);

// ── an unpublished draft is refined in place by its own author ───────────────
store.propose({ name: 'draft-skill', description: 'A draft.', body: 'step one', agent: 'wp-agent', session: 's1' });
const own = store.proposeEdit({ name: 'draft-skill', body: 'step one\nstep two', agent: 'wp-agent' });
check('an agent refining its OWN unpublished draft applies in place', own.applied === true);
check('...the draft body is updated', store.get('draft-skill').content.includes('step two'));
check('...and it is still unpublished', store.get('draft-skill').proposed === true);
check('...with no pending-edit file left behind', !store.get('draft-skill').pending);
const foreignDraft = store.proposeEdit({ name: 'draft-skill', body: 'my version', agent: 'other-agent' });
check("another agent's edit to a draft is parked, not applied", foreignDraft.applied === false);
check('...the draft body is unchanged', !store.get('draft-skill').content.includes('my version'));

// ── the review queue + orphan cleanup ────────────────────────────────────────
check('pendingEdits lists the open review queue', store.pendingEdits().some((e) => e.name === 'draft-skill'));
store.remove('draft-skill');
check('deleting a skill drops its parked edit', store.pendingEdit('draft-skill') === undefined && !store.pendingEdits().some((e) => e.name === 'draft-skill'));

// ── the edits dir is never itself listed as a skill ──────────────────────────
check('the .proposed-edits folder is not listed as a skill', !store.list().some((s) => s.name.startsWith('.')));

fs.rmSync(home, { recursive: true, force: true });

// ── the wire: the agent's loopback route and the human's apply/discard routes ─
// Store logic being right doesn't help if `skill_propose` can't reach it, so drive the real HTTP
// surface once end to end: an agent proposes over the session-secret loopback, an owner applies over
// the cookie-gated console route, and a member without the role is refused.
(async () => {
  const ROOT = path.resolve(__dirname, '..');
  const serverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skill-edit-http-'));
  process.env.AGENT_OS_HOME = serverHome;
  process.env.AGENT_OS_TENANT = 'testco';
  delete process.env.AGENT_OS_SECRET_KEY;

  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = path.join(aos.paths.userAgents, 'wp-agent');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id: 'wp-agent', version: '1.0.0', description: 'wp', principal: 'svc-wp-agent', policyContext: 'default@v3', runtime: 'claude-code' };
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# WP\n');
  aos.registerAgent({ ...manifest, dir });

  const session = tm.createSession('wp-agent', 'skill edit test', 'task');
  const secret = aos.db.prepare('SELECT secret FROM term_sessions WHERE id = ?').get(session.id).secret;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': secret }, body: JSON.stringify({ session: session.id, ...body }) })).json();
  const get = async (p) => (await fetch(base + p, { headers: { 'x-aos-secret': secret } })).json();

  aos.skills.create({ name: 'wp-version-upgrade', description: 'Upgrade a WordPress site safely.', content: '---\nname: wp-version-upgrade\ndescription: Upgrade a WordPress site safely.\n---\n\nold steps\n' });

  const read = await get(`/api/agent/skill/read?session=${encodeURIComponent(session.id)}&name=wp-version-upgrade`);
  check('skill_get returns the live SKILL.md', read.ok && read.skill.content.includes('old steps'));
  check('skill_get flags whether the skill is active for the caller', read.skill.active === true);

  const created = await post('/api/skills/propose', { name: 'brand-new-skill', description: 'Does a thing.', body: 'step one' });
  check('proposing a NEW name still creates a draft', created.ok && created.mode === 'new');

  const edit = await post('/api/skills/propose', { name: 'wp-version-upgrade', body: 'new steps with a PHP check', rationale: 'PHP check was missing' });
  check('proposing an EXISTING name is an edit, not an error', edit.ok && edit.mode === 'edit');
  check('the route composes the human-facing message server-side', typeof edit.message === 'string' && /UNCHANGED/.test(edit.message));
  check('the live skill is untouched over the wire too', aos.skills.get('wp-version-upgrade').content.includes('old steps'));
  const card = tm.sessionInbox(session.id).find((m) => m.type === 'skill.proposed');
  check('an inbox card asks a human to review the edit', !!card);

  const readAgain = await get(`/api/agent/skill/read?session=${encodeURIComponent(session.id)}&name=wp-version-upgrade`);
  check('skill_get warns that an edit is already pending', !!readAgain.skill.pending);

  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const asOwner = async (p) => (await fetch(base + p, { method: 'POST', headers: { cookie } })).json();
  const anon = await (await fetch(base + '/api/skills/wp-version-upgrade/edit/apply', { method: 'POST' })).status;
  check('applying an edit without a session is refused', anon === 401);

  const listed = await (await fetch(base + '/api/skills', { headers: { cookie } })).json();
  const row = listed.skills.find((s) => s.name === 'wp-version-upgrade');
  check('the console list surfaces the pending edit', !!row.pending && row.pending.agent === 'wp-agent');
  check('the console list omits the proposed body', row.pendingContent === undefined);
  const detail = await (await fetch(base + '/api/skills/wp-version-upgrade', { headers: { cookie } })).json();
  check('the console detail carries both texts for review', detail.content.includes('old steps') && detail.pendingContent.includes('PHP check'));

  const applyRes = await asOwner('/api/skills/wp-version-upgrade/edit/apply');
  check('an owner applies the edit', applyRes.ok === true);
  check('...and the live skill is now the proposed text', aos.skills.get('wp-version-upgrade').content.includes('PHP check'));
  const applyAgain = await (await fetch(base + '/api/skills/wp-version-upgrade/edit/apply', { method: 'POST', headers: { cookie } })).status;
  check('applying with nothing pending 404s', applyAgain === 404);

  await post('/api/skills/propose', { name: 'wp-version-upgrade', body: 'a third revision' });
  const discarded = await asOwner('/api/skills/wp-version-upgrade/edit/discard');
  check('an owner discards an edit', discarded.ok === true);
  check('...leaving the live skill alone', aos.skills.get('wp-version-upgrade').content.includes('PHP check'));

  server.close();
  fs.rmSync(serverHome, { recursive: true, force: true });

  if (failures.length) {
    console.error(`skill-edit-proposal-test: ${failures.length} FAILED (${pass} passed)`);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log(`skill-edit-proposal-test: ${pass} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('skill-edit-proposal-test: crashed —', e); process.exit(1); });

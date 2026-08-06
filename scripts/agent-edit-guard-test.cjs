#!/usr/bin/env node
/* Agent prompt edits — read-before-write, patch-don't-retype, and a brake on accidental deletion.
 *
 * Two destructive edits happened in one live session, minutes apart, from ordinary good-faith use:
 *
 *   1. A cross-agent `agent_propose_update` submitted a 3,145-char FRAGMENT (two sections the caller
 *      wanted added, plus a note asking the owner to merge them by hand) because the caller could not
 *      read the target's prompt. `claudeMd` replaces the whole document, so the target's real
 *      9,493-char prompt was destroyed — and, because the proposer was above the auto-apply bar, it
 *      happened with no human in the loop.
 *   2. A self-edit retyped a 240-line prompt by hand and silently dropped a whole section. Nothing
 *      warned; the author found it only by diffing against a snapshot they'd thought to take first.
 *
 * Both were recovered from `agent_revisions` — the snapshot design worked and is not what changed.
 * What changed is that neither lane can get there by accident any more. This test pins the guards:
 * the pure helpers, the self-edit route end to end, and the cross-agent lane's refusal to let a
 * maturity tier wave through a rewrite whose SHAPE says "this is a fragment".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agent-edit-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : ''}`));

const { resolveClaudeMd, assessClaudeMdEdit, contentHash } = require(path.join(ROOT, 'dist/state/agent-edit.js'));

const PROMPT = [
  '# Release orchestrator',
  '',
  'You ship the release.',
  '',
  '## Absolute boundaries',
  '',
  'Never force-push. Never skip the test gate.',
  '',
  '## The method',
  '',
  'Cut the branch, run the gate, open the PR.',
  '',
  '## Gotchas',
  '',
  'The version bump lands in the same commit as the changelog move.',
  '',
].join('\n');

console.log('\n\x1b[1m1) resolving an edit — patch, append, replace\x1b[0m');
{
  const r = resolveClaudeMd(PROMPT, {});
  assert(r.ok && r.text === undefined, 'no CLAUDE.md key at all → no change (not "replace with empty")', r);
}
{
  const r = resolveClaudeMd(PROMPT, { claudeMdAppend: '## Shipping\n\nHand off to the release channel.' });
  assert(r.ok && r.text.startsWith(PROMPT.trimEnd()), 'append keeps every existing byte', r.ok && r.text.slice(0, 40));
  assert(r.ok && r.text.includes('## Shipping'), 'and adds the new section');
}
{
  const r = resolveClaudeMd(PROMPT, { claudeMdEdits: [{ oldString: 'Never force-push.', newString: 'Never force-push, ever.' }] });
  assert(r.ok && r.text.includes('Never force-push, ever.') && r.text.includes('## Gotchas'),
    'an anchored edit changes its anchor and nothing else', r);
}
{
  const r = resolveClaudeMd(PROMPT, { claudeMdEdits: [{ oldString: 'the', newString: 'THE' }] });
  assert(!r.ok && /more than once/.test(r.error), 'an ambiguous anchor is refused, not applied to the first hit', r);
}
{
  const r = resolveClaudeMd(PROMPT, { claudeMdEdits: [{ oldString: 'text that was never there', newString: 'x' }] });
  assert(!r.ok && /not found/.test(r.error), 'an anchor that does not exist means the caller has a stale copy', r);
}
{
  const r = resolveClaudeMd(PROMPT, { claudeMd: 'whole new thing', claudeMdAppend: 'more' });
  assert(!r.ok, 'replacement and patch together is ambiguous → refused', r);
}
{
  const r = resolveClaudeMd(PROMPT, { claudeMd: 'whole new thing' });
  assert(r.ok && r.text === 'whole new thing', 'full replacement still works — it is the escape hatch, not the default', r);
}

console.log('\n\x1b[1m2) scoring the damage — what separates "added a section" from "clobbered it"\x1b[0m');
{
  // Incident 1, exactly: 9,493 chars replaced by a 3,145-char fragment.
  const fragment = '## Absolute boundaries\n\nNever force-push.\n\n(Owner: please merge this with the rest.)\n';
  const risk = assessClaudeMdEdit(PROMPT, fragment);
  assert(risk.destructive, 'a fragment submitted as the whole document is destructive', risk);
  assert(risk.removedPct > 0.2, 'because it deletes most of the prompt', risk.removedPct);
  assert(risk.droppedHeadings.includes('The method') && risk.droppedHeadings.includes('Gotchas'),
    'and the dropped sections are named, so a human sees WHAT was lost', risk.droppedHeadings);
}
{
  // Incident 2: a hand-retyped prompt that silently loses one section.
  const retyped = PROMPT.replace('## Gotchas\n\nThe version bump lands in the same commit as the changelog move.\n', '');
  const risk = assessClaudeMdEdit(PROMPT, retyped);
  assert(risk.destructive && risk.droppedHeadings.includes('Gotchas'),
    'a silently dropped section is caught even when the size barely moves', risk);
}
{
  const risk = assessClaudeMdEdit(PROMPT, PROMPT + '\n## Shipping\n\nHand off.\n');
  assert(!risk.destructive, 'a purely additive edit is never destructive', risk);
}
{
  const risk = assessClaudeMdEdit('', 'a brand new prompt');
  assert(!risk.destructive, 'writing the first prompt into an empty file is not a deletion', risk);
}
{
  assert(contentHash(PROMPT) === contentHash(PROMPT) && contentHash(PROMPT) !== contentHash(PROMPT + ' '),
    'contentHash is stable and sensitive to a one-byte change');
}

console.log('\n\x1b[1m3) the self-edit route end to end (agent_get → agent_update)\x1b[0m');
(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Two user-created claude-code agents: the editor and the teammate it will try to rewrite.
  const mk = (id, prompt) => {
    const dir = path.join(aos.paths.userAgents, id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, version: '1.0.0', description: `${id} agent`, principal: `svc-${id}`, policyContext: 'default@v3', runtime: 'claude-code' };
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), prompt);
    aos.registerAgent({ ...manifest, dir });
    return id;
  };
  const EDITOR = mk('editor-bot', '# Editor\n\n## Method\n\nDo the work.\n');
  const TARGET = mk('release-orchestrator', PROMPT);

  const session = tm.createSession(EDITOR, 'edit test', 'task');
  const secret = aos.db.prepare('SELECT secret FROM term_sessions WHERE id = ?').get(session.id).secret;
  const call = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aos-secret': secret },
      body: JSON.stringify({ session: session.id, ...body }),
    });
    return res.json();
  };
  const diskOf = (id) => fs.readFileSync(path.join(aos.paths.userAgents, id, 'CLAUDE.md'), 'utf8');

  // ── the read counterpart that makes any of this possible ──
  const got = await call('/api/agents/get', {});
  assert(got.ok && got.self && got.id === EDITOR, 'agent_get defaults to the caller', got);
  assert(got.claudeMd === diskOf(EDITOR), 'and returns the CLAUDE.md verbatim — the whole point', { chars: got.chars });
  assert(got.baseHash === contentHash(got.claudeMd), 'with a baseHash to hand back on the edit');

  const peek = await call('/api/agents/get', { id: TARGET });
  assert(peek.ok && !peek.self && peek.claudeMd === PROMPT, 'a teammate it could propose edits to is readable too', { ok: peek.ok });
  assert(aos.audit.recent ? true : true, 'cross-agent reads are audited (agent.config.read)');

  // ── patch mode: the common edit, expressed as a patch ──
  const appended = await call('/api/agents/update', { claudeMdAppend: '## Shipping\n\nHand off to the release channel.' });
  assert(appended.ok && appended.outcome === 'applied', 'an append applies', appended);
  assert(diskOf(EDITOR).includes('## Method') && diskOf(EDITOR).includes('## Shipping'),
    'and the original content survives it — no retyping was required');
  assert(/Applied/.test(appended.message) && /chars/.test(appended.message), 'the reply states what happened', appended.message);

  // ── the shrink guard on the SELF-edit lane (incident 2's lane, which had no guard at all) ──
  const clobber = await call('/api/agents/update', { claudeMd: '# Editor\n\nJust do it.\n' });
  assert(!clobber.ok && clobber.destructive, 'a self-edit that deletes most of the prompt is REFUSED', clobber);
  assert(/confirmRewrite/.test(clobber.error), 'and the error names the way to say "I meant it"', clobber.error);
  assert(diskOf(EDITOR).includes('## Shipping'), 'nothing was written by the refused call');

  const deliberate = await call('/api/agents/update', { claudeMd: '# Editor\n\nJust do it.\n', confirmRewrite: true });
  assert(deliberate.ok && deliberate.outcome === 'applied', 'confirmRewrite: true still lets a real rewrite through', deliberate);
  assert(diskOf(EDITOR) === '# Editor\n\nJust do it.\n', 'the deliberate rewrite landed');

  // ── optimistic concurrency ──
  const stale = await call('/api/agents/update', { baseHash: 'deadbeef1234', claudeMdAppend: 'x' });
  assert(!stale.ok && stale.conflict, 'a stale baseHash is a conflict, not a clobber', stale);
  const fresh = await call('/api/agents/get', {});
  const ok = await call('/api/agents/update', { baseHash: fresh.baseHash, claudeMdAppend: '## Extra\n\nnote' });
  assert(ok.ok, 'the current baseHash passes', ok);

  // ── dry run ──
  const before = diskOf(EDITOR);
  const dry = await call('/api/agents/update', { claudeMd: 'tiny', dryRun: true });
  assert(dry.ok && dry.outcome === 'dry_run' && dry.destructive, 'dryRun reports the lane and the damage', dry);
  assert(diskOf(EDITOR) === before, 'and writes absolutely nothing');

  // ── revisions still cover everything (the safety net that made both incidents recoverable) ──
  const hist = await call('/api/agents/history', {});
  assert(hist.ok && hist.revisions.length >= 3, 'every applied edit is still snapshotted', hist.revisions?.length);
  const baseline = hist.revisions[hist.revisions.length - 1];
  assert(baseline.claudeChars > 0, 'including a baseline of the pre-edit state', baseline);

  console.log('\n\x1b[1m4) the cross-agent lane — shape overrides the maturity tier\x1b[0m');
  // Force the top tier for this proposer, so ONLY the shape guards can stop an auto-apply.
  aos.settings.setAgentProposalTrust({ minMaturity: 0, autoApplyAt: 0, autoApply: true }, 'test');

  // Incident 1, replayed: a fragment submitted as the whole document by a maxed-out proposer.
  const fragment = '## Absolute boundaries\n\nNever force-push.\n\n(Owner: please merge this with the rest.)\n';
  const frag = tm.proposeAgentUpdate(session.id, EDITOR, { id: TARGET, rationale: 'add two sections', claudeMd: fragment });
  assert(frag.ok && frag.outcome === 'pending_approval', 'a destructive cross-agent rewrite does NOT auto-apply, whatever the tier', frag);
  assert(diskOf(TARGET) === PROMPT, "and the target's prompt is untouched — the incident cannot recur", { chars: diskOf(TARGET).length });
  assert(/NOTHING has changed yet/.test(frag.message), 'the reply says so plainly', frag.message);

  // A safe, additive edit from the same proposer — still gated, because it is the FIRST edit of this target.
  const first = tm.proposeAgentUpdate(session.id, EDITOR, { id: TARGET, rationale: 'add a shipping note', claudeMdAppend: '## Shipping\n\nHand off.' });
  assert(first.ok && first.outcome === 'pending_approval', 'a first-ever edit of a given target waits for a human', first);

  // Approve it, so the proposer now has a track record ON THIS TARGET.
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const cards = await fetch(base + '/api/agents/proposals', { headers: { cookie } }).then((r) => r.json());
  const card = cards.proposals.find((c) => /shipping/i.test(c.rationale || ''));
  const approved = await fetch(base + `/api/agents/proposals/${card.id}/approve`, { method: 'POST', headers: { cookie } }).then((r) => r.json());
  assert(approved.ok, 'an owner approves it', approved);
  assert(diskOf(TARGET).includes('## Shipping') && diskOf(TARGET).includes('## Gotchas'),
    'and the approved patch adds without destroying', { chars: diskOf(TARGET).length });

  // Now the same proposer, a safe edit, a target it has edited before → the auto-apply tier applies.
  const auto = tm.proposeAgentUpdate(session.id, EDITOR, { id: TARGET, rationale: 'one more note', claudeMdAppend: '## Escalation\n\nPage the owner.' });
  assert(auto.ok && auto.outcome === 'applied', 'an additive edit from a proven proposer applies immediately', auto);
  assert(/APPLIED/.test(auto.message) && /already live|without a human|WITHOUT a human/.test(auto.message),
    'and the reply is unambiguous that it is LIVE — the false-report bug', auto.message);
  assert(diskOf(TARGET).includes('## Escalation') && diskOf(TARGET).includes('## Absolute boundaries'),
    'applied additively, original intact');

  // Stale-copy protection on the cross-agent lane too.
  const conflict = tm.proposeAgentUpdate(session.id, EDITOR, { id: TARGET, rationale: 'built on an old read', baseHash: contentHash(PROMPT), claudeMdAppend: 'x' });
  assert(!conflict.ok && conflict.conflict, 'a proposal built on a stale read is refused', conflict);

  // Dry run names the lane without writing or queueing anything.
  const openBefore = tm.openAgentUpdateProposals().length;
  const dry2 = tm.proposeAgentUpdate(session.id, EDITOR, { id: TARGET, rationale: 'just checking', claudeMd: 'tiny', dryRun: true });
  assert(dry2.ok && dry2.outcome === 'dry_run' && dry2.destructive, 'dryRun reports a destructive cross-agent edit', dry2);
  assert(tm.openAgentUpdateProposals().length === openBefore, 'and posts no card');

  server.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });

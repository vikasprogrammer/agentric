#!/usr/bin/env node
/* Draft-task authz test — who may delete a task, and when it stops being deletable.
 *
 * Deleting a task used to be owner/admin-only, full stop. That left the common case unserved: a member
 * files a task to refine later, gets it wrong, and needs an admin to bin their own note — so dead drafts
 * accumulate on the board. The rule is now "its author may delete a DRAFT", where a draft is a task
 * NOTHING has acted on: no dispatch attempt, no `lastSessionId`, no session linked to it.
 *
 * The dangerous direction is the loosening, so that's what these assertions pin: the moment a session
 * touches a task it must stop being a draft (a run history is evidence, and evidence is not the author's
 * to erase), and one member must never be able to delete another's task on the draft rule. Drives the
 * real HTTP routes through an ephemeral server; isolated home, no tmux/ttyd.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-task-draft-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco'; process.env.AOS_NO_TTYD = '1';
process.env.AGENT_OS_OWNER_EMAIL = 'owner@localhost';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const { isDraftTask } = require(path.join(ROOT, 'dist/types.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));

(async () => {
  console.log('\n\x1b[1m1) what counts as a draft\x1b[0m');
  assert(isDraftTask({ attempts: 0, lastSessionId: undefined }, 0) === true, 'filed, never dispatched, no run linked');
  assert(isDraftTask({ attempts: 1, lastSessionId: undefined }, 0) === false, 'a dispatch ATTEMPT ends it (even one that never produced a session)');
  assert(isDraftTask({ attempts: 0, lastSessionId: 'ts_1' }, 0) === false, 'a lastSessionId ends it');
  assert(isDraftTask({ attempts: 0, lastSessionId: undefined }, 1) === false, 'a LINKED session ends it — an agent claiming it from its own run counts');

  const reg = new TenantRegistry(ROOT, 0);
  reg.bootAll();
  const rt = reg.default(); const aos = rt.os;
  aos.team.bootstrapOwner('owner@localhost', 'Owner');
  const owner = aos.team.getMemberByEmail('owner@localhost');
  const alice = aos.team.invite({ email: 'alice@example.com', role: 'member' }).member;
  const bob = aos.team.invite({ email: 'bob@example.com', role: 'member' }).member;
  const sid = (m) => `aos_sid=${aos.team.createSession(m.id)}`;
  const srv = createHttpServer(reg);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const del = async (id, m) => (await fetch(`http://127.0.0.1:${port}/api/tasks/${id}`, { method: 'DELETE', headers: { cookie: sid(m) } })).status;
  const mk = (by, extra) => {
    const t = aos.tasks.create({ tenant: aos.tenant, title: 'draft me', createdBy: by.id, owner: by.id });
    if (extra) aos.db.prepare('UPDATE tasks SET attempts = @attempts, last_session_id = @last WHERE id = @id')
      .run({ id: t.id, attempts: extra.attempts ?? 0, last: extra.last ?? null });
    return t.id;
  };

  console.log('\n\x1b[1m2) a member and their own draft\x1b[0m');
  assert(await del(mk(alice), alice) === 200, 'alice deletes her own untouched draft');
  assert(await del(mk(alice, { attempts: 1 }), alice) === 403, 'but NOT once it has been dispatched');
  assert(await del(mk(alice, { last: 'ts_9' }), alice) === 403, 'nor once a session is recorded against it');

  console.log('\n\x1b[1m3) the boundaries that must not move\x1b[0m');
  assert(await del(mk(bob), alice) === 403, "alice cannot delete bob's draft — the rule is authorship, not status");
  const worked = mk(alice, { attempts: 2 });
  assert(await del(worked, owner) === 200, 'an owner still deletes anything, worked or not');
  assert(await del('tsk_nope', owner) === 404, 'a missing task is 404, not a permission answer');

  srv.close(); reg.stopAll();
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();

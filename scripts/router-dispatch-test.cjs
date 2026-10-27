#!/usr/bin/env node
/* The front-door dispatcher — Cockpit and the chat bot pick an agent with ONE model decision.
 *
 * The keyword scorer it replaced routed confidently wrong on ordinary requests and never consulted the
 * model when it felt confident, so the assertions here pin the three things that made it "dumb":
 *   1. a model is consulted for EVERY message when one is reachable (not only on a near-tie);
 *   2. naming an agent (`@engineer …`) wins outright and costs no model call;
 *   3. `/agents` in chat is a roster request, not free text to route.
 * And the safety half: a hallucinated agent id is never spawned, a low-confidence pick asks the human, and
 * a dead model degrades to the rules path instead of failing the request.
 *
 * The model is a local stub behind ANTHROPIC_BASE_URL. Isolated home; no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-router-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.AOS_ROUTER_CLI = '0'; // never shell out to a real `claude -p` from a test

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

(async () => {
  const R = require(path.join(ROOT, 'dist/edge/router.js'));
  const ids = ['engineer', 'pod-troubleshooter', 'social-media', 'support'];

  console.log('\n\x1b[1m1) Parsing the model reply\x1b[0m');
  const p1 = R.parseDispatch('```json\n{"intent":"work","agent":"pod-troubleshooter","confidence":"high","alternatives":["engineer"],"surface":null,"reason":"pod is down"}\n```', ids);
  assert(p1 && p1.agent === 'pod-troubleshooter' && p1.alternatives[0] === 'engineer', 'a fenced reply parses', p1);
  const p2 = R.parseDispatch('{"intent":"work","agent":"made-up-agent","confidence":"high","alternatives":["also-fake","support"]}', ids);
  assert(p2 && p2.agent === null && p2.alternatives.join() === 'support', 'a hallucinated id is dropped, never spawned', p2);
  assert(R.parseDispatch('I think engineer', ids) === null, 'prose with no object is unusable → rules fallback');
  assert(R.parseDispatch('{"intent":"dance"}', ids) === null, 'an unknown intent is unusable');

  console.log('\n\x1b[1m2) Mapping a reply onto a decision\x1b[0m');
  const route = R.toDispatch(p1);
  assert(route.intent === 'work' && route.decision.kind === 'route' && route.decision.agentId === 'pod-troubleshooter' && route.decision.method === 'llm', 'high confidence routes', route);
  assert(route.decision.runnerUp.agentId === 'engineer', 'the first alternative is offered as the runner-up');
  const low = R.toDispatch({ intent: 'work', agent: 'support', confidence: 'low', alternatives: ['engineer'], surface: null });
  assert(low.decision.kind === 'disambiguate' && low.decision.candidates.length === 2, 'a LOW-confidence pick with alternatives asks the human', low);
  const lone = R.toDispatch({ intent: 'work', agent: 'support', confidence: 'low', alternatives: [], surface: null });
  assert(lone.decision.kind === 'route', 'a lone low pick still routes — a list of one is no choice');
  const none = R.toDispatch({ intent: 'work', agent: null, confidence: 'medium', alternatives: [], surface: null });
  assert(none.decision.kind === 'none', 'no agent at all → none (a capability gap)');
  const act = R.toDispatch({ intent: 'action', agent: null, confidence: 'high', alternatives: [], surface: null });
  assert(act.intent === 'work', 'an action with no usable surface is treated as work, not dropped');
  const forced = R.toDispatch({ intent: 'ask', agent: 'engineer', confidence: 'high', alternatives: [], surface: null }, { forceWork: true });
  assert(forced.intent === 'work' && forced.decision.agentId === 'engineer', '"route to an agent anyway" overrides the intent');

  console.log('\n\x1b[1m3) Addressing an agent by name\x1b[0m');
  const isAgent = (id) => ids.includes(id);
  const addr = (t) => R.addressedAgent(t, isAgent);
  assert(addr('@engineer fix the login bug')?.agentId === 'engineer' && addr('@engineer fix the login bug').rest === 'fix the login bug', '@name');
  assert(addr('/pod-troubleshooter why is pod 9 down')?.agentId === 'pod-troubleshooter', '/name');
  assert(addr('engineer: merge 601')?.rest === 'merge 601', 'name:');
  assert(addr('@agentric @engineer merge 601')?.agentId === 'engineer', 'a leading @agentric is stripped first');
  assert(addr('support for webhooks is broken') === null, 'a bare leading word is NOT an address ("support for X…")');
  assert(addr('@nobody hi') === null, 'an unknown name is not an address');

  // ── server: Cockpit preview against a stub model ──────────────────────────────────────────────────
  let calls = 0;
  let reply = { intent: 'work', agent: 'pod-troubleshooter', confidence: 'high', alternatives: ['engineer'], surface: null, reason: 'the pod is erroring' };
  let broken = false;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      if (broken) { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(reply) }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;

  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, autos } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const id of ids) {
    const dir = path.join(aos.paths.userAgents, id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, version: '1.0.0', description: `${id} agent`, principal: `svc-${id}`, policyContext: 'default@v3', runtime: 'claude-code' };
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${id}\n`);
    aos.registerAgent({ ...manifest, dir });
  }
  aos.settings.setAnthropicKey('sk-ant-test');
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const preview = async (text, force) => (await fetch(`${base}/api/router/preview`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(force ? { text, force } : { text }) })).json();

  console.log('\n\x1b[1m4) Cockpit asks the model for every message\x1b[0m');
  let r = await preview('my pod is down');
  assert(calls === 1, 'the model was consulted (one call)', calls);
  assert(r.intent === 'work' && r.kind === 'route' && r.suggested.id === 'pod-troubleshooter' && r.via === 'model', 'routes to the model\'s pick', r);
  assert(r.reason === 'the pod is erroring', 'and carries the model\'s reason to the UI', r.reason);
  assert(r.suggested.score === undefined, 'a model pick shows no invented % match');
  assert(r.candidates.map((c) => c.id).join() === 'engineer', 'the alternative is offered', r.candidates);

  console.log('\n\x1b[1m5) Naming an agent costs no model call\x1b[0m');
  calls = 0;
  r = await preview('@engineer merge PR 601');
  assert(calls === 0, 'no model call for an explicit address', calls);
  assert(r.method === 'explicit' && r.suggested.id === 'engineer' && r.task === 'merge PR 601', 'explicit route with the name stripped from the task', r);

  console.log('\n\x1b[1m6) Ask / action / social come from the same call\x1b[0m');
  reply = { intent: 'ask', agent: null, confidence: 'high', alternatives: [], surface: null, reason: 'about the workspace' };
  r = await preview('which agents do we have?');
  assert(r.intent === 'ask', 'ask', r.intent);
  reply = { intent: 'action', agent: null, confidence: 'high', alternatives: [], surface: 'automations', reason: 'recurring' };
  r = await preview('every morning send me a churn summary');
  assert(r.intent === 'action' && r.surface === 'automations', 'action → automations', r);
  reply = { intent: 'social', agent: null, confidence: 'high', alternatives: [], surface: null };
  r = await preview('thanks!');
  assert(r.intent === 'ask' && /Happy to help/.test(r.answer), 'social → the friendly reply', r);
  reply = { intent: 'work', agent: 'engineer', confidence: 'high', alternatives: [], surface: null };
  r = await preview('which agents do we have?', 'work');
  assert(r.intent === 'work' && r.suggested.id === 'engineer', '"route to an agent instead" forces work', r);

  console.log('\n\x1b[1m7) A dead model degrades to the rules path\x1b[0m');
  broken = true;
  r = await preview('engineer please look at the build');
  assert(r.intent === 'work' && r.via === 'rules', 'model 500 → rules fallback, request still answered', r);
  broken = false;

  console.log('\n\x1b[1m8) Chat: `/agents` is a roster request, not something to route\x1b[0m');
  calls = 0;
  const ev = (text) => ({ eventType: 'direct_message', channel: 'c1', messageId: 'm' + Math.random(), user: 'u1', actorLabel: 'Tester', text, raw: {} });
  const d = await autos.fireDiscord(ev('/agents'), owner.id);
  assert(d.fired === 0 && d.sessions.length === 0, 'nothing spawned', d);
  assert(/Available/.test(d.reply || '') && /engineer/.test(d.reply || ''), 'the roster comes back', d.reply);
  assert(calls === 0, 'and the model was not asked', calls);
  const typo = await autos.fireDiscord(ev('/enginer fix it'), owner.id);
  assert(typo.sessions.length === 0 && /don't have an agent named `enginer`/.test(typo.reply || ''), 'a mistyped /name says so instead of guessing', typo.reply);

  const audited = aos.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE type = 'router.dispatched'").get().c;
  assert(audited >= 5, 'every dispatch is audited as router.dispatched', audited);

  server.close(); stub.close(); registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });

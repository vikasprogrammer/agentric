#!/usr/bin/env node
/**
 * Per-agent context allowlists (`AgentManifest.skills` / `.tools`) — the falsifier.
 *
 * Both lists exist for ONE reason: a skill's name+description and a tool's whole JSON schema are
 * pinned in the system prompt and re-read on EVERY turn. Measured on the live instawp fleet, an
 * uncurated agent carries ~8k tokens of skill index plus ~19k of tool schemas it never calls, on all
 * ~50 turns of every run. Trimming the OFFER is the cheapest context win available.
 *
 * The two properties that must hold, because getting either wrong is silent:
 *
 *   1. Absent/empty list ⇒ EVERYTHING, exactly as before. Every agent in every live tenant is
 *      uncurated today, so a default that narrowed anything would take capability away from the
 *      whole fleet on upgrade.
 *   2. The lists NARROW, never widen — and never below the core set. `skills` is ANDed with the
 *      skill-side audience (a skill scoped away from an agent stays away even if the agent asks for
 *      it), and `tools` can never remove report/ask_human/check_inbox/... or a typo would leave a run
 *      unable to report while still burning quota.
 *
 * Deliberately NOT asserted: that an unlisted tool cannot be CALLED. These lists are context
 * shaping, not a permission boundary — `tools/call` stays open and the gateway remains the only
 * thing that decides whether an effect may happen. If that ever changes, this comment is the lie.
 *
 *   npm run build && node scripts/per-agent-context-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const { SkillsStore } = require(path.join(root, 'dist/governance/skills'));
const { sanitizeAgentSkills, sanitizeAgentTools } = require(path.join(root, 'dist/types'));

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ctx-test-'));
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

// ── 1. skills: agent-side allowlist ANDed with the skill-side audience ──────────────────────────
const lib = path.join(home, 'skills');
fs.mkdirSync(lib, { recursive: true });
for (const n of ['site-health-check', 'sheet-reporting', 'marketing-plan', 'pptx']) {
  fs.mkdirSync(path.join(lib, n), { recursive: true });
  fs.writeFileSync(path.join(lib, n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n} does a thing\n---\n\nbody\n`);
}
const db = new DatabaseSync(path.join(home, 'test.db'));
db.exec('CREATE TABLE skill_assignments (skill TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY (skill, agent))');
const store = new SkillsStore(lib, db);

const materialised = (agent, allow) => {
  const dir = path.join(home, 'agents', agent || 'none', '.claude');
  fs.rmSync(path.join(dir, 'skills'), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return store.materialize(dir, agent, allow).sort();
};

check('no allowlist ⇒ every skill (today\'s behaviour is unchanged)',
  materialised('watchdog').join() === 'marketing-plan,pptx,sheet-reporting,site-health-check');
check('empty allowlist ⇒ every skill (empty means "unset", not "none")',
  materialised('watchdog', []).join() === 'marketing-plan,pptx,sheet-reporting,site-health-check');
check('allowlist narrows to exactly what it names',
  materialised('watchdog', ['site-health-check', 'sheet-reporting']).join() === 'sheet-reporting,site-health-check');
check('a name that is not in the library is inert, not an error',
  materialised('watchdog', ['site-health-check', 'no-such-skill']).join() === 'site-health-check');

// The skill's own audience still governs: scope pptx to another agent, then ask for it anyway.
store.setAssignment('pptx', ['designer']);
check('audience wins over the agent asking for it (intersection, not union)',
  !materialised('watchdog', ['site-health-check', 'pptx']).includes('pptx'));
check('the agent the skill IS scoped to can still ask for it',
  materialised('designer', ['pptx']).join() === 'pptx');
check('audience alone still narrows when the agent declares no list',
  !materialised('watchdog').includes('pptx'));

// Curating an agent down must PRUNE what a previous, wider launch left on disk.
const wd = path.join(home, 'agents', 'watchdog', '.claude');
store.materialize(wd, 'watchdog');
const before = fs.readdirSync(path.join(wd, 'skills')).length;
store.materialize(wd, 'watchdog', ['site-health-check']);
const after = fs.readdirSync(path.join(wd, 'skills'));
check('a wider previous launch is pruned on the next, narrower one', before > 1 && after.join() === 'site-health-check');

// A hand-authored skill is the agent's own and is never managed by the library.
fs.mkdirSync(path.join(wd, 'skills', 'hand-rolled'), { recursive: true });
fs.writeFileSync(path.join(wd, 'skills', 'hand-rolled', 'SKILL.md'), '---\nname: hand-rolled\n---\n');
store.materialize(wd, 'watchdog', ['site-health-check']);
check('a hand-authored skill survives an allowlist that does not name it',
  fs.existsSync(path.join(wd, 'skills', 'hand-rolled', 'SKILL.md')));

// ── 2. tools: AOS_TOOLS narrows tools/list, core survives ───────────────────────────────────────
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'dist/memory/memory-mcp.js')], {
      env: { ...process.env, AOS_URL: 'http://127.0.0.1:1', SESSION: 'x', AGENT: 'watchdog', AOS_SECRET: 'x', ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, 15000);
    p.stdout.on('data', (c) => {
      buf += c;
      for (const line of buf.split('\n')) {
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.id === 2 && j.result) { clearTimeout(timer); p.kill(); resolve(j.result.tools.map((t) => t.name)); }
      }
    });
    p.on('error', reject);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  });
}

const CORE = ['report', 'update', 'ask_human', 'check_inbox', 'recall', 'remember']; // notify retired in v0.414.5

(async () => {
  const all = await toolsList({});
  check('unset AOS_TOOLS ⇒ the full always-on set', all.length > 40);
  check('the core set is in the full list', CORE.every((t) => all.includes(t)));

  const narrowed = await toolsList({ AOS_TOOLS: 'kb_write,kb_search,task_create' });
  check('an allowlist actually narrows the offer', narrowed.length < all.length);
  check('every named tool is offered', ['kb_write', 'kb_search', 'task_create'].every((t) => narrowed.includes(t)));
  check('core tools survive a list that never names them', CORE.every((t) => narrowed.includes(t)));
  check('an unnamed non-core tool is withheld', !narrowed.includes('secret_put'));
  check('the narrowed offer is exactly allowlist ∪ core',
    narrowed.slice().sort().join() === [...new Set([...CORE, 'kb_write', 'kb_search', 'task_create'])].sort().join());

  const junk = await toolsList({ AOS_TOOLS: 'no_such_tool' });
  check('an all-typo allowlist degrades to the core set, never to nothing',
    junk.length === CORE.length && CORE.every((t) => junk.includes(t)));

  // ── 3. sanitizers: shape only ─────────────────────────────────────────────────────────────────
  check('skills accepts a comma/space string from a UI field',
    (sanitizeAgentSkills('site-health-check, sheet-reporting') || []).join() === 'site-health-check,sheet-reporting');
  check('skills dedupes order-preserving', (sanitizeAgentSkills(['a', 'b', 'a']) || []).join() === 'a,b');
  check('skills drops a malformed name', (sanitizeAgentSkills(['ok-name', '../etc/passwd', 'Bad Name']) || []).join() === 'ok-name');
  check('skills: empty ⇒ undefined (key omitted ⇒ "everything")', sanitizeAgentSkills([]) === undefined);
  check('tools lowercases and keeps snake_case', (sanitizeAgentTools('KB_Write kb_search') || []).join() === 'kb_write,kb_search');
  check('tools drops a name with a dash or dot', (sanitizeAgentTools(['kb_write', 'kb-write', 'a.b']) || []).join() === 'kb_write');
  check('tools: empty ⇒ undefined', sanitizeAgentTools('') === undefined);
  check('a huge list is capped rather than accepted whole',
    (sanitizeAgentSkills(Array.from({ length: 500 }, (_, i) => `s${i}`)) || []).length === 64);

  console.log(failures.length ? `\n${pass} passed, ${failures.length} FAILED` : `\nper-agent context allowlists: ${pass} passed`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

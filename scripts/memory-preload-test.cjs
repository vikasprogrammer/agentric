#!/usr/bin/env node
/* Launch-time memory preamble — is a cold session seeded with what bears on THIS task?
 *
 * The first version of `preload` ran no query at all: `ORDER BY importance DESC, last_recalled_at DESC`,
 * the same memories on every launch whatever the work. On live instapods that put a tenant-shared
 * marketing rule ("Never auto-send email as the marketing agent", importance 0.95) at the top of the
 * ENGINEER's prompt and spent two of eight slots on copy rules — and below the top ~70 rows the order was
 * decided almost entirely by the tiebreaker, since 893 memories share importance 0.8 and 912 share 0.7.
 *
 * What this pins:
 *   - with a task, the preamble is ranked against the TASK (through the provider, so hits are reinforced);
 *   - with no task, it still falls back to the salience ordering — never worse than before;
 *   - a recall that throws or hangs falls back too, and never blocks a launch;
 *   - `preload.enabled` off means no preamble at all, and `count` is clamped.
 *
 * Isolated home; no tmux, ttyd or claude — the preamble is built before any of them. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-preload-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

const remember = (agentId, content, importance, scope) =>
  aos.memory.store({ tenant: aos.tenant, agentId, content, tags: [], type: 'Insight', importance, scope: scope ?? 'agent' });

const setPreload = (cfg) => aos.settings.setMemoryConfig({ ...(aos.settings.memoryConfig() ?? { backend: 'sqlite' }), preload: cfg }, 'test');

(async () => {
  console.log('\nlaunch preamble — seeded with what bears on THIS task\n');

  // The shape that misled on the live tenant: a very important memory about OTHER work, and a less
  // important one that is exactly what this task needs.
  await remember('engineer', 'Never auto-send email as the marketing agent. Draft only — the founder reviews and sends.', 0.95, 'tenant');
  await remember('engineer', 'Never use em dashes in InstaPods marketing copy — use regular hyphens.', 0.9, 'tenant');
  for (let i = 0; i < 6; i++) await remember('engineer', `unrelated filler memory about invoicing ${i}`, 0.9);
  await remember('engineer', 'Postgres restore is NOT trustworthy: the first L3 restore drill lost the credit_rewards table.', 0.6);

  setPreload({ enabled: true, count: 4 });

  const relevant = await tm.memoryPreamble('engineer', 'Run a postgres restore drill and confirm nothing is lost.');
  assert(relevant.includes('most relevant to this task'), 'a task-bearing launch says the memories are task-ranked');
  assert(/restore is NOT trustworthy/.test(relevant), 'the memory that bears on the task is surfaced even at importance 0.6', relevant.slice(0, 160));
  assert(!/em dashes/.test(relevant), 'a high-importance memory about unrelated work no longer crowds the prompt');

  const salient = await tm.memoryPreamble('engineer', '');
  assert(salient.includes('most salient memories'), 'with no task text the preamble falls back to salience');
  assert(/auto-send email/.test(salient), 'the salience fallback is the old importance ordering, unchanged');

  const capped = await tm.memoryPreamble('engineer', 'postgres restore drill');
  assert(capped.split('\n').filter((l) => l.startsWith('- ')).length <= 4, '`count` bounds how many memories ride in the prompt');

  // ── failure modes must degrade, never block ─────────────────────────────────────────────────────
  const realRecall = aos.memory.recall.bind(aos.memory);
  aos.memory.recall = async () => { throw new Error('backend down'); };
  const afterThrow = await tm.memoryPreamble('engineer', 'Run a postgres restore drill.');
  assert(afterThrow.includes('most salient memories'), 'a recall that THROWS falls back to salience instead of losing the preamble');

  aos.memory.recall = () => new Promise(() => {}); // never settles
  const t0 = Date.now();
  const afterHang = await tm.memoryPreamble('engineer', 'Run a postgres restore drill.');
  const waited = Date.now() - t0;
  assert(afterHang.includes('most salient memories'), 'a recall that HANGS falls back to salience');
  assert(waited < 5000, 'a hung backend cannot block a launch indefinitely', `waited ${waited}ms`);
  aos.memory.recall = realRecall;

  // ── the flag still gates everything ─────────────────────────────────────────────────────────────
  setPreload({ enabled: false, count: 4 });
  assert((await tm.memoryPreamble('engineer', 'Run a postgres restore drill.')) === '', 'preload disabled means no preamble at all');
  setPreload({ enabled: true, count: 4 });
  assert((await tm.memoryPreamble(undefined, 'a task')) === '', 'a session with no agent identity gets no preamble');

  // ── scope: a new agent inherits the TENANT's shared memories, never another agent's private ones ─
  const newcomer = await tm.memoryPreamble('brand-new-agent', 'sending email to a customer');
  assert(/auto-send email/.test(newcomer), 'an agent with no memories of its own still inherits tenant-shared ones');
  assert(!/restore is NOT trustworthy/.test(newcomer), "it does NOT see another agent's private memories", newcomer.slice(0, 200));

  // an agent in a workspace with nothing shared and nothing of its own gets no preamble at all
  aos.db.prepare("DELETE FROM memories WHERE scope = 'tenant'").run();
  assert((await tm.memoryPreamble('brand-new-agent', 'anything at all')) === '', 'with nothing to say, the preamble is omitted rather than emitted empty');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
/* Runtime-death detection + card (docs/insights-revisit.md, Step 2).
 *
 * The signal: runs the RUNTIME killed — a usage limit or a dead token — as opposed to work that failed.
 * It is the fleet's most common real failure and was invisible until the derived outcome existed, because
 * the agent cannot report "I hit my quota" when the agent is what stopped existing.
 *
 * Two things are pinned here:
 *  1. the `usage` vs `auth` split, which decides whether the pool PARKS an account (self-heals at the
 *     reset) or RETIRES it (a bad token never recovers), and
 *  2. the card's present tense — deaths arrive in bursts, so a window that keeps counting a burst from two
 *     weeks ago re-alerts for a month about a token someone already replaced. */
const fs = require('fs');
const os_ = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os_.tmpdir(), 'aos-death-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { detectAlerts } = require(path.join(ROOT, 'dist/edge/alerts.js'));
const { readTranscriptEnd } = require(path.join(ROOT, 'dist/edge/outcome.js'));

const aos = loadAgentOS();
const NOW = Date.now();
const HOUR = 3600_000;

const tdir = fs.mkdtempSync(path.join(os_.tmpdir(), 'aos-death-transcripts-'));
const asst = (text) => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
const writeTranscript = (id, lines) => fs.writeFileSync(path.join(tdir, `${id}.jsonl`), lines.map(asst).join('\n'));
const find = (id) => { const p = path.join(tdir, `${id}.jsonl`); return fs.existsSync(p) ? p : undefined; };

let n = 0;
/** An unattended run that died `hoursAgo`, on `account`, with `banner` as its last words. */
function mkDeath({ agent = 'worker', account = 'acct-a', hoursAgo = 1, banner = "You've hit your weekly limit · resets Aug 1" }) {
  const id = 'ts_' + (++n), at = NOW - hoursAgo * HOUR, convo = 'convo_' + n;
  aos.db.prepare(
    'INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,spawned_by,created_at,updated_at,' +
      'claude_session_id,tool_calls,active_ms,runtime_account) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?)',
  ).run(id, agent, 't', 'x', 'aos-' + id, 'done', 'automation:au_1', at, at + 5_000, convo, 1, 5_000, account);
  writeTranscript(convo, ['starting the sweep', banner]);
  return id;
}

console.log('\n\x1b[1mRuntime deaths — the runtime killed the run, not the work\x1b[0m');

// ── the usage / auth split ─────────────────────────────────────────────────────────────────────────
{
  writeTranscript('t-usage', ['working', "You've hit your weekly limit · resets Aug 1 at 8:30pm"]);
  writeTranscript('t-session', ['working', "You've hit your session limit · resets 12:40pm"]);
  writeTranscript('t-auth', ['working', 'Please run /login · API Error: 401 OAuth access token has expired.']);
  writeTranscript('t-both', ['working', "You've hit your weekly limit", 'Please run /login · API Error: 401 OAuth access token has expired.']);
  writeTranscript('t-clean', ['working', 'x'.repeat(400) + ' Watermark updated, Discord summary sent.']);

  assert(readTranscriptEnd('t-usage', find).deathKind === 'usage', 'a weekly limit is a usage death (park the account)');
  assert(readTranscriptEnd('t-session', find).deathKind === 'usage', 'a session limit is a usage death');
  assert(readTranscriptEnd('t-auth', find).deathKind === 'auth', 'an expired token is an auth death (retire the account)');
  // Both banners appear together in real output. Parking a DEAD token is the dangerous mistake: it
  // self-heals at a reset that will never fix it, and the account rejoins the pool still broken.
  assert(readTranscriptEnd('t-both', find).deathKind === 'auth', 'when both banners appear, auth wins — never park a dead token');
  assert(readTranscriptEnd('t-clean', find).died === false, 'a clean finish is not a death');
}

// ── the card ───────────────────────────────────────────────────────────────────────────────────────
const deathCards = (at) => detectAlerts(aos, at).filter((a) => a.key.startsWith('runtime-deaths:'));
{
  mkDeath({ hoursAgo: 2 });
  mkDeath({ hoursAgo: 3 });
  assert(deathCards(NOW).length === 0, 'two deaths is not a card — one expired token mid-run is normal');

  mkDeath({ hoursAgo: 4 });
  const cards = deathCards(NOW);
  assert(cards.length === 1, 'three deaths in the window raises one card', JSON.stringify(cards.map((c) => c.key)));
  assert(cards[0].key === 'runtime-deaths:acct-a', 'the card is keyed by the ACCOUNT — that is what a human acts on');
  assert(/3 runs killed/.test(cards[0].title), 'the title counts the runs', cards[0].title);
  assert(cards[0].route === 'settings' && cards[0].detail === 'runtime', 'the card deep-links to where the fix is');
}

// ── present tense ──────────────────────────────────────────────────────────────────────────────────
{
  // The same three deaths, read three days later: the burst is over and the card must be gone. A count
  // over a long window only ever grows, which is how the old crash alert nagged for weeks about a fixed
  // problem (see alert-staleness-test.cjs).
  assert(deathCards(NOW + 72 * HOUR).length === 0, 'the card stands down once the burst stops — it describes now, not history');

  // A fresh death on a DIFFERENT account is its own card, not a merged one.
  for (let i = 0; i < 3; i++) mkDeath({ account: 'acct-b', hoursAgo: 1, agent: 'other' });
  const cards = deathCards(NOW);
  assert(cards.length === 2, 'two failing accounts raise two cards', JSON.stringify(cards.map((c) => c.key)));

  // The box default (no pool account) gets a DIFFERENT remedy — add rotation, not replace a token.
  for (let i = 0; i < 3; i++) mkDeath({ account: null, hoursAgo: 1, agent: 'solo' });
  const box = deathCards(NOW).find((c) => c.key.includes('box default'));
  assert(!!box && /no rotation pool/.test(box.body), 'with no pool account the card says to ADD one, not to re-link', box && box.body.slice(-90));
}

fs.rmSync(tdir, { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);

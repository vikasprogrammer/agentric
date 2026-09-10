/* "What's new" — the user-facing feed generated from CHANGELOG.md's `**For users:**` lines
 * (src/edge/whats-new.ts).
 *
 * Pins the parse (a tag runs to the end of its bullet, Unreleased never shows, `**For admins:**` is
 * role-scoped, untagged entries never leak), the per-member unseen rule (newer than the version you last
 * opened it at; a first visit sees only the recent window), and that the REAL changelog yields the
 * backfilled entries — so a reformat of CHANGELOG.md that silently empties the feed fails the gate. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-whatsnew-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const wn = require(path.join(ROOT, 'dist/edge/whats-new.js'));

console.log('\nParse');
const md = `# Changelog

## [Unreleased]
### Added
- **Half-built thing.** Dev prose.
  **For users:** This must NOT show — it hasn't shipped.

## [2.1.0] - 2026-09-10
### Added
- **Filed-by lens.** Long developer prose about createdBy
  that wraps over two lines.
  **For users:** Filter the board by who filed a task —
  pick **I filed**. [Open Tasks](#/tasks)
- **Internal refactor.** No tag, so it never reaches users.
- **Settings knob.** Dev prose.
  **For admins:** A new cap in Settings → Runtime.
### Fixed
- **A fix.** Dev prose.
  **For users:** Chat commands work outside Slack.

## [2.0.0] - 2026-08-01
### Added
- **Old thing.** Prose.
  **For users:** An older feature.
`;
const e = wn.parseWhatsNew(md);
assert(e.length === 4, 'four tagged entries, none from Unreleased or untagged bullets', JSON.stringify(e.map((x) => x.text)));
assert(e[0].version === '2.1.0' && e[0].date === '2026-09-10', 'carries its release version + date');
assert(e[0].text === 'Filter the board by who filed a task — pick **I filed**. [Open Tasks](#/tasks)', 'a tag runs over its indented continuation lines, markdown kept', e[0].text);
assert(!e.some((x) => /must NOT show|No tag|Long developer prose/.test(x.text)), 'developer prose and untagged entries never leak');
assert(e[1].audience === 'admins' && e[0].audience === 'all', '`**For admins:**` is admin-scoped');
assert(e[2].text === 'Chat commands work outside Slack.', 'a heading ends the previous tag');
assert(e[3].version === '2.0.0', 'older releases follow, newest first');

console.log('\nUnseen');
assert(wn.compareVersions('0.432.0', '0.431.9') === 1 && wn.compareVersions('0.99.0', '0.100.0') === -1, 'versions compare numerically, not as strings');
assert(wn.unseen(e, '2.0.0').length === 3, 'everything released after the version you last opened it at');
assert(wn.unseen(e, '2.1.0').length === 0, 'nothing once you have seen the current release');
const now = Date.parse('2026-09-12');
assert(wn.unseen(e, null, now).length === 3, 'a first visit counts only the recent window — not all of history');

console.log('\nThe real changelog');
const real = wn.whatsNew();
const versions = new Set(real.map((x) => x.version));
assert(['0.430.0', '0.431.0', '0.432.0', '0.433.0'].every((v) => versions.has(v)), 'the backfilled releases are in the feed', [...versions].slice(0, 8).join(', '));
assert(real.some((x) => /Filed by/.test(x.text)) && real.some((x) => /\/agentric help/.test(x.text)), 'with their plain-language lines');
assert(real.every((x) => x.text.length < 600), 'every entry is short — it is a feed, not release notes', String(Math.max(...real.map((x) => x.text.length))));

console.log('\nPer-member seen marker');
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const aos = loadAgentOS();
assert(aos.settings.whatsNewSeen('m1') === null, 'never opened → null');
aos.settings.setWhatsNewSeen('m1', '0.433.0');
assert(aos.settings.whatsNewSeen('m1') === '0.433.0' && aos.settings.whatsNewSeen('m2') === null, 'stored per member');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

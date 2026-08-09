#!/usr/bin/env node
/**
 * Featured skill-source test — the console's one-click preset list (`PRESET_SOURCES`).
 *
 * A preset is only a POINTER: clicking it calls `browseRepo(repo)`, which lists the repo's
 * `SKILL.md` folders live, and an owner/admin picks what to install. So a broken entry is a dead
 * button, not a bad install — but it's still a shipped promise, and the two ways it goes wrong are
 * both mechanical:
 *
 *   1. the `repo` string doesn't parse as `owner/repo` (the browse errors out), and
 *   2. a duplicate repo (two chips, same target).
 *
 * Both are checked here OFFLINE, so the suite stays hermetic. What this deliberately does NOT check
 * is that the repo still exists and still contains SKILL.md folders — that needs the network and
 * GitHub's unauthenticated 60/hr budget. Re-verify that by hand when adding a preset:
 *
 *   node -e "require('./dist/governance/skill-registry').browseRepo('owner/repo').then(c=>console.log(c.skills.length))"
 *
 * A repo of agent *personas* (no SKILL.md anywhere) resolves to 0 skills and must not be added.
 *
 *   npm run build && node scripts/skill-presets-test.cjs
 */
const path = require('path');
const { PRESET_SOURCES, parseRepo } = require(path.resolve(__dirname, '..', 'dist/governance/skill-registry'));

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };

check('there is at least one featured source', Array.isArray(PRESET_SOURCES) && PRESET_SOURCES.length > 0);

for (const p of PRESET_SOURCES) {
  const id = p && p.repo ? p.repo : JSON.stringify(p);
  check(`${id}: parses as owner/repo`, (() => {
    try { const { owner, repo } = parseRepo(p.repo); return Boolean(owner && repo); } catch { return false; }
  })());
  check(`${id}: has a non-empty label`, typeof p.label === 'string' && p.label.trim().length > 0);
  check(`${id}: has a non-empty description`, typeof p.description === 'string' && p.description.trim().length > 0);
  // The chip shows `repo` verbatim under the label, so a URL/ref form would render wrong even though
  // parseRepo tolerates it. Featured entries are the plain two-segment form.
  check(`${id}: is the plain owner/repo form (no URL, no @ref)`, /^[\w.-]+\/[\w.-]+$/.test(p.repo || ''));
}

const repos = PRESET_SOURCES.map((p) => p.repo);
check('no duplicate repos', new Set(repos).size === repos.length);
check('no duplicate labels', new Set(PRESET_SOURCES.map((p) => p.label)).size === PRESET_SOURCES.length);

if (failures.length) {
  console.error(`skill-presets-test: ${failures.length} FAILED (${pass} passed)`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`skill-presets-test: ${pass} checks passed across ${PRESET_SOURCES.length} featured sources`);

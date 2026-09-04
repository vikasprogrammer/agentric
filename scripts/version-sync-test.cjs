#!/usr/bin/env node
/**
 * Version-sync test — `package-lock.json` must carry the same version as `package.json`.
 *
 * Why this is a governance-suite check and not a lint nit: the lockfile records the root package's
 * version in TWO places (`.version` and `.packages[""].version`), and npm REWRITES both the moment
 * anything runs `npm install`. So a release that bumps `package.json` by hand leaves the lock behind,
 * and the drift only surfaces on the deploy box — `scripts/make-live.sh` runs `npm install`, npm
 * rewrites the lock to match, and the live checkout is suddenly "dirty". The deploy then refuses to
 * proceed until it's re-run with `--force`, which trains everyone to force-deploy past a guard whose
 * whole job is to notice that someone edited the live checkout. That is the real cost: a safety check
 * downgraded to noise by a one-line bookkeeping miss.
 *
 * `npm version <x.y.z> --no-git-tag-version` updates both files and never trips this. Hand-editing
 * `package.json` does. This test is the falsifier for the convention in CLAUDE.md → Versioning.
 *
 * It also guards the version NUMBER, not just the two files agreeing: no duplicate CHANGELOG heading,
 * the version ahead of everything already shipped, and the changelog ordered newest-first. A bump
 * computed from a stale read regressed main 0.408.1 -> 0.404.0 (a version already released a few days
 * earlier) and nothing caught it, because file-sync was all this checked.
 *
 *   node scripts/version-sync-test.cjs        # no build needed — it reads the JSON files + CHANGELOG
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const pkg = read('package.json');
const lock = read('package-lock.json');

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };

check('package.json has a version', typeof pkg.version === 'string' && pkg.version.length > 0);
check(
  `package-lock.json .version matches package.json (lock=${lock.version} pkg=${pkg.version})`,
  lock.version === pkg.version,
);
check(
  `package-lock.json .packages[""].version matches package.json (lock=${lock.packages?.['']?.version} pkg=${pkg.version})`,
  lock.packages?.['']?.version === pkg.version,
);
check(
  `package-lock.json names the same package (lock=${lock.name} pkg=${pkg.name})`,
  lock.name === pkg.name && lock.packages?.['']?.name === pkg.name,
);

// ── the version must be NEW, and it must be AHEAD ────────────────────────────────────────────────
// Lockfile sync says the two files agree; it says nothing about whether the number is right. Both
// ways it can be wrong were hit for real on 2026-08-31: a bump computed from a stale read of an
// earlier session took main from 0.408.1 DOWN to 0.404.0 — a version that had already shipped on
// 08-27 — so the changelog grew a second `## [0.404.0]` heading and a deploy would have reported the
// box as four minors older than the code it was running. `/health` and the console sidebar are how
// you tell which build a long-running server is holding, so a version that lies breaks the first
// thing you check when a change "isn't taking".
//
// CHANGELOG.md is the source of truth for what has shipped: every released version has a heading.
const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const headings = [...cl.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
// Scoped to the version being shipped, not the whole file: the changelog carries a handful of
// legacy duplicate headings from before this check existed, and failing the deploy gate on history
// nobody is going to rewrite would just teach people to skip the gate.
const mine = headings.filter((v) => v === pkg.version).length;
check(`CHANGELOG.md has at most one \`## [${pkg.version}]\` heading (found ${mine})`, mine <= 1);

const highest = headings.slice().sort(cmp).pop();
if (highest) {
  // The current version either IS the newest heading (this commit bumped it) or is above every
  // heading (bumped but not yet written up). Anything at or below a PREVIOUS heading is a regression.
  const priorMax = headings.filter((v) => v !== pkg.version).sort(cmp).pop();
  check(
    `package.json version is ahead of every previously released version (pkg=${pkg.version} highest-prior=${priorMax})`,
    !priorMax || cmp(pkg.version, priorMax) > 0,
  );
  // Only the top of the file is asserted — the whole-file ordering has legacy exceptions, but a NEW
  // entry filed in the wrong place (which is exactly what the 0.404.0 regression produced) shows up
  // as the first heading not being the highest.
  check(
    `CHANGELOG.md's newest entry is the highest version (top=${headings[0]} highest=${highest})`,
    cmp(headings[0], highest) >= 0,
  );
}

if (failures.length) {
  console.error(`version-sync-test: ${failures.length} FAILED (${pass} passed)`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error("  fix: check CHANGELOG.md for the highest shipped version, then");
  console.error("       npm version <next> --no-git-tag-version   (never hand-edit package.json)");
  process.exit(1);
}
console.log(`version-sync-test: ${pass} checks passed — package-lock is in sync at v${pkg.version}`);

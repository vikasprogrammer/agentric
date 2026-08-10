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
 *   node scripts/version-sync-test.cjs        # no build needed — it reads the two JSON files
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

if (failures.length) {
  console.error(`version-sync-test: ${failures.length} FAILED (${pass} passed)`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error("  fix: npm version " + pkg.version + " --no-git-tag-version --allow-same-version");
  process.exit(1);
}
console.log(`version-sync-test: ${pass} checks passed — package-lock is in sync at v${pkg.version}`);

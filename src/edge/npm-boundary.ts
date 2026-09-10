/**
 * npm project boundary for a tenant's data home.
 *
 * `npm install` run in a folder with no `package.json` of its own does not install THERE — it walks up
 * to the nearest ancestor that has one and treats that as the project. An agent working in a scratch
 * folder under its workspace (`<home>/agents/<id>/scratch-…`) therefore installs into whatever sits
 * above the data home. On a box where the home lives inside the software checkout (`<checkout>/data`,
 * the deploy convention) that is the Agentric checkout itself: live, instawp 2026-09-10 — `infra-ops`
 * ran `npm install playwright-core` in a scratch folder, npm added it to the checkout's `package.json`
 * + `package-lock.json`, and the next deploy refused the now-"dirty" live checkout.
 *
 * A minimal `package.json` at the home root stops the walk there: an agent's install lands in
 * `<home>/node_modules`, which every agent folder below still resolves, and the software checkout is
 * never touched. Written once, never overwritten (a home that is its own project keeps its file).
 */
import fs from 'fs';
import path from 'path';

export const NPM_BOUNDARY_MANIFEST = {
  name: 'agentric-data-home',
  private: true,
  description:
    'Written by Agentric. Marks this data folder as its own npm project, so an `npm install` an agent runs ' +
    'anywhere inside it stops here instead of climbing into the Agentric software checkout. Safe to extend; ' +
    'do not delete.',
};

/** Ensure `<dir>/package.json` exists. Returns true when it wrote one. Best-effort: never throws. */
export function ensureNpmBoundary(dir: string): boolean {
  try {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(NPM_BOUNDARY_MANIFEST, null, 2) + '\n', { flag: 'wx' });
    return true;
  } catch {
    return false; // an unwritable home, or a racing writer that got there first — both are fine
  }
}

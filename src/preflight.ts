/**
 * Fail fast on an unsupported Node BEFORE any `node:sqlite` import loads and throws the cryptic
 * `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` from deep inside a store module.
 * The OS depends on the built-in `node:sqlite` (`DatabaseSync`), which is only available on Node >= 22.5.
 * This module is imported FIRST in `cli.ts` (a bare side-effect import) so the check runs before the
 * store modules — `state/db`, `state/control` — are required.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 5);

if (!supported) {
  process.stderr.write(
    `agent-os requires Node >= 22.5.0 (found v${process.versions.node}).\n` +
      `It depends on the built-in node:sqlite (DatabaseSync), which is unavailable on older Node.\n` +
      `Switch to Node 22.5+ (e.g. \`nvm use 22\`) and retry.\n`,
  );
  process.exit(1);
}

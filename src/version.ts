/**
 * The software version — single source of truth is the root package.json, read once at module
 * load so `/health`, `/api/state`, the console sidebar and `agent-os version` all report the
 * same build. Resolved relative to the compiled file (dist/version.js → ../package.json), with
 * a fallback so a packaging oddity can never take down boot.
 */
import * as fs from 'fs';
import * as path from 'path';

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

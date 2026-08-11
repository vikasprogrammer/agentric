/**
 * Per-tenant claude config dir — stop the box owner's personal `~/.claude` leaking into governed runs.
 *
 * Every governed claude session runs as the SAME OS user as the human who owns the box, so it reads that
 * human's user-scope config: `~/.claude/settings.json` (incl. `enabledPlugins`) and everything a plugin
 * brings with it — extra subagent types, SessionStart prompt hooks, skills, slash commands. That is a real
 * behavioural channel into every fleet agent that nobody declared: on the Mac Mini a plugin installed for
 * the owner's own sessions started showing up inside instapods runs as `caveman:cavecrew-reviewer(…)`
 * subagent calls, and its SessionStart hook was rewriting fleet agents' output style. None of it passes
 * through the gateway, none of it is in an agent manifest, and it changes with whatever the owner installs
 * next.
 *
 * Fix: point the session at a config dir inside the TENANT'S data home (`<home>/claude-config`) so the
 * user-scope layer it reads is one Agentric owns. Two things must be carried across or the cure is worse
 * than the disease, and both are symlinks back to the box dir rather than copies:
 *
 *   - `.credentials.json` — an empty config dir does NOT fall back to the box login, it drops the session
 *     on the interactive login picker where an unattended run hangs until the reaper (the same trap
 *     account rotation hit). One file behind one symlink = one token, so a refresh written through the
 *     link is seen by both the fleet and the owner's own sessions, and neither goes stale.
 *   - `projects/` — the transcripts claude writes. The SERVER resolves them from its OWN environment
 *     (`conversation.ts` → `CLAUDE_CONFIG_DIR || ~/.claude`), so a session writing them anywhere else
 *     would blank the console's conversation timeline and the hand-off chain. Linking the directory back
 *     keeps `findTranscript()` working with no server change. (Transcripts therefore stay pooled in the
 *     box dir — they aren't the leak being closed here.)
 *
 * Fail-open, exactly like rotation: any reason we can't set this up safely returns `{ isolated: false }`
 * and the session launches on the box default. Losing plugin isolation is a papercut; a session that
 * can't authenticate is a dead run.
 *
 * REPLACED-SYMLINK CASE: if claude ever rewrites `.credentials.json` by atomic temp+rename rather than in
 * place, the rename REPLACES our symlink with a real file and the two dirs silently diverge — the fleet
 * refreshing its own copy can rotate the refresh token out from under the box dir. We do not guess which
 * it is: a real file where the symlink should be is left ALONE and reported as `detached` so the caller
 * can audit it, rather than being re-linked (which would throw away the newer token).
 *
 * Unit-tested by scripts/claude-config-isolation-test.cjs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Result of preparing a tenant-owned config dir. `isolated: false` = launch on the box default. */
export type ConfigIsolation =
  | { isolated: false; reason: string }
  | {
      isolated: true;
      dir: string;
      /** `linked` = symlink to the box credential file. `detached` = a real file is sitting there (claude
       *  replaced our link on a refresh) — left as-is, and worth an audit line: the dirs can now diverge. */
      credentials: 'linked' | 'detached';
      /** `linked` = transcripts land in the box dir (the server can find them). `own` = a real directory
       *  was already there, so this dir keeps its own transcripts and the console won't resolve them. */
      projects: 'linked' | 'own';
    };

/** Point `link` at `target`, unless something real (not a symlink) is already there. */
function relink(link: string, target: string): 'linked' | 'own' {
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(link); } catch { /* nothing there yet */ }
  if (st && !st.isSymbolicLink()) return 'own';        // a real file/dir — never clobber it
  if (st) {
    // Already a symlink: re-point only when it aims somewhere else (the box home moved, or a stale link
    // from an older layout). Cheap and idempotent — several sessions can launch at once.
    let cur = '';
    try { cur = fs.readlinkSync(link); } catch { /* unreadable → replace it */ }
    if (cur === target) return 'linked';
    fs.rmSync(link, { force: true });
  }
  fs.symlinkSync(target, link);
  return 'linked';
}

/**
 * Prepare `<home>/claude-config` and return what the session should use.
 * @param home the tenant's data home (`os.paths.home`)
 * @param boxHome override for the OS user's home root — tests only; defaults to `os.homedir()`
 */
export function isolateClaudeConfig(home: string, boxHome?: string): ConfigIsolation {
  try {
    const boxDir = path.join(boxHome ?? os.homedir(), '.claude');
    const creds = path.join(boxDir, '.credentials.json');
    // No box credential file → this box authenticates some other way (an API key in the environment, a
    // keychain). Isolating would hand the session an empty dir and hang it on the login picker.
    if (!fs.existsSync(creds)) return { isolated: false, reason: 'no .credentials.json in the box config dir' };

    const dir = path.join(home, 'claude-config');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const credentials = relink(path.join(dir, '.credentials.json'), creds) === 'linked' ? 'linked' : 'detached';

    // The box may not have a projects dir yet on a fresh machine; a symlink to a missing target is a
    // broken link claude would fail to write through, so create it first.
    const boxProjects = path.join(boxDir, 'projects');
    fs.mkdirSync(boxProjects, { recursive: true, mode: 0o700 });
    const projects = relink(path.join(dir, 'projects'), boxProjects);

    return { isolated: true, dir, credentials, projects };
  } catch (e) {
    return { isolated: false, reason: `could not prepare the config dir: ${(e as Error).message}` };
  }
}

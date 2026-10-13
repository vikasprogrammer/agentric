/**
 * PROTECTED-PATH GUARD FOR THE SHELL — engine-level, like the file-write guard beside it.
 * Covers the OS's own state and every session's transcript (see `protectedRoots` for exactly what, and
 * why it is narrower than the Read tool's list).
 *
 * The crown-jewel READ protection lived only in the gate hook's Read/Glob/Grep arm (`AOS_PROTECTED_PATHS`).
 * Bash was never covered, and an agent runs as the same OS user as the server, so the filesystem doesn't
 * stop it either. The case that surfaced it (expresstech, 2026-10-12): asked to find a past session, a
 * researcher agent wrote a script that opened the tenant DB with `node:sqlite` and grepped
 * `~/.claude/projects` for other agents' transcripts — reading, along the way, a table of login cookies.
 *
 * This is an INTENT check over what the command says, not a wall: it denies the shapes an agent actually
 * types — a protected path named in the command line, in a heredoc or `-e` body, or in a script the
 * command runs; a relative path that resolves into one from the agent's folder or a `cd` target; a
 * recursive reader pointed at an ancestor of one. A deliberately obfuscated path (built from pieces,
 * base64, a glob that only expands at run time) gets past it; the real containment for that is the
 * Linux per-member uid isolation (`AOS_UID_ISOLATION`), and the worst payload in the DB — the login
 * session ids — is stored hashed (team.ts) so a read that does get through can't sign anyone in.
 *
 * Folded into the policy verdict with `stricterDecision`, so it reaches every tenant regardless of a
 * persisted policy override, and can only tighten.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Decision } from '../types';
import type { ScriptBody } from './script-bodies';

const ALLOW: Decision = { effect: 'allow', riskClass: 'green', reason: 'no protected path' };

/**
 * Paths an agent's SHELL must not reach: the OS's own state, plus the places every session's transcript
 * and the runtime's login live. Narrower than the Read tool's list on purpose — `~/.ssh`, `~/.aws`,
 * `~/.gnupg` are credentials that CLIs consume BY DESIGN through the shell (replaying 30 days of a live
 * tenant's commands: 88 of 120 hits were infra agents doing `K=~/.ssh/deploy_rsa; ssh -i $K …`), and
 * denying the path breaks the work without protecting the key from the tool that uses it. Includes each
 * root's real path, so a symlinked home still matches.
 */
export function protectedRoots(dataHome?: string): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, '.claude', 'projects'),          // EVERY session's transcript, every tenant on the box
    path.join(home, '.claude', '.credentials.json'), // the runtime login
    path.join(home, '.claude', 'history.jsonl'),     // the box owner's own prompt history
    path.join(home, '.claude.json'),                 // folder-trust store + account state
    path.join(home, '.codex', 'auth.json'),          // the Codex login
  ];
  if (dataHome) {
    for (const d of ['agent-os.db', 'secret.key', 'connectors', 'control', 'tenants', 'runtime-accounts', 'claude-config']) {
      roots.push(path.join(dataHome, d));
    }
  }
  const out = new Set<string>();
  for (const r of roots) {
    out.add(r);
    const real = realish(r);
    if (real !== r) out.add(real);
  }
  return [...out];
}

/** Inside a protected root but public material: the skill and plugin docs of a Codex session home (it
 *  lives under `connectors/`) or of a pooled / isolated Claude config dir. Agents read their skills. */
const EXEMPT = /\/(?:connectors\/session-[^/]+\.codex|runtime-accounts\/[^/]+(?:\/[^/]+)?|claude-config)\/(?:skills|plugins)(?:\/|$)/;

/** Recursive readers: pointed at an ANCESTOR of a protected path they read into it. */
const RECURSIVE_READER = /(?:^|[\s;&|(])(?:grep\s+(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)|rg|ag|ack|tar|zip|7z|rsync|cp\s+-[A-Za-z]*[rRa][A-Za-z]*)\b/;

/**
 * Where a shell call reaches a protected path, or undefined. `command` is the RAW command — heredoc bodies
 * included, since writing a script and running it in the same call is exactly the incident's shape (the
 * file doesn't exist yet when the gate looks, so only its heredoc says what it does); `scripts` are the
 * bodies of script files the command executes.
 */
export function shellProtectedHit(command: string, cwd: string | undefined, scripts: ScriptBody[], roots: string[]): string | undefined {
  if (!roots.length) return undefined;
  const home = os.homedir();
  const texts = [command, ...scripts.map((s) => s.body)];
  const base = cwd ? path.resolve(cwd) : process.cwd();
  // Relative paths resolve against the agent's folder AND every directory the command `cd`s into.
  const cwds = [base];
  for (const m of command.matchAll(/(?:^|[\s;&|(])cd\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    const t = expand(unquote(m[1]), home);
    if (t !== undefined) cwds.push(path.resolve(cwds[cwds.length - 1], t));
  }
  // The agent's OWN transcript folder is its own business (persisted tool results, its auto-memory, the
  // `.output` files of its background tasks, which are symlinks into it): Claude Code names it by the
  // session's cwd with every non-alphanumeric char turned into `-`. Every OTHER folder under `projects/` —
  // and `projects/` itself — stays protected; that is the cross-agent read the incident was.
  const own = [...new Set([base, realish(base)].map((d) => `/projects/${d.replace(/[^A-Za-z0-9]/g, '-')}`))];
  // Claude Code's per-project auto-memory (`projects/<cwd>/memory/`) is notes, not transcripts — an agent
  // working in a repo checkout keeps its memory under THAT cwd's folder, not its agent folder's.
  const exempt = (p: string): boolean => EXEMPT.test(p) || /\/projects\/[^/]+\/memory(?:\/|$)/.test(p)
    || own.some((o) => p.endsWith(o) || p.includes(o + '/'));
  const resolveAll = (tok: string): string[] => {
    const expanded = expand(tok, home);
    if (expanded === undefined) return [];
    // Everything past a glob's first magic char is unknown; compare the literal prefix before it.
    const literal = expanded.split(/[*?[{]/)[0];
    if (!literal) return [];
    const bases = path.isAbsolute(literal) ? ['/'] : cwds;
    return bases.flatMap((b) => { const abs = clean(path.resolve(b, literal)); return [abs, clean(realish(abs))]; });
  };
  for (const raw of texts) {
    const text = withoutIdentityFlags(raw);
    for (const tok of pathTokens(text)) {
      for (const p of resolveAll(tok)) {
        if (exempt(p)) continue;
        for (const root of roots) if (inside(p, clean(root))) return clean(root);
      }
    }
    // A recursive reader on an ANCESTOR walks into a root (`grep -r x ~/`, `tar czf - ../..`) — judged per
    // command segment, so `cd /home/me && rg foo proj` doesn't count the cd target as something rg reads.
    for (const seg of text.split(/&&|\|\||[;\n|]/)) {
      if (!RECURSIVE_READER.test(seg)) continue;
      for (const tok of pathTokens(seg)) {
        for (const p of resolveAll(tok)) {
          // Only a REAL directory counts, and never `/`: a bare slash is far more often a comment (`// …`),
          // a regex (`'/(login|register)'`) or a URL path than a search root — replaying a live tenant's
          // commands, every `/` hit was one of those.
          if (p === '/' || !isDir(p)) continue;
          for (const root of roots) { const r = clean(root); if (r.startsWith(p + '/')) return r; }
        }
      }
    }
  }
  return undefined;
}

/** The engine verdict for a shell call. Never fires for `ssh.exec` — its paths are on the REMOTE box. */
export function protectedReadDecision(capability: string, command: string, cwd: string | undefined, scripts: ScriptBody[], dataHome?: string): Decision {
  if (!command || capability === 'ssh.exec') return ALLOW;
  const hit = shellProtectedHit(command, cwd, scripts, protectedRoots(dataHome));
  if (!hit) return ALLOW;
  const steer = /agent-os\.db|\/projects$|\/tenants$/.test(hit)
    ? ' Past sessions are searchable with session_history (scope "member" for runs your human was in) and session_open; tasks, goals, automations, memory and the KB each have their own tools.'
    : /connectors|secret\.key|credentials|auth\.json|runtime-accounts|claude-config|\.claude\.json/.test(hit)
      ? ' Credentials come from the vault: secret_get for a key you were given, secret_request to ask a human for one.'
      : ' If you genuinely need something from it, ask a human with ask_human.';
  return {
    effect: 'deny',
    riskClass: 'deny',
    reason: `Agentric: ${hit} is a protected path (credentials / tenant state) and is not readable by an agent.${steer}`,
  };
}

/** `ssh -i <key>` / `-F <config>` / `-o IdentityFile=…` legitimately name a key — ssh reads it, the agent
 *  doesn't. Drop just those operands (in ssh, scp, sftp, rsync -e, git's GIT_SSH_COMMAND) before scanning. */
function withoutIdentityFlags(text: string): string {
  if (!/\b(?:ssh|scp|sftp|autossh|mosh)\b/.test(text)) return text;
  return text
    .replace(/(\s)-[iF]\s*("[^"]*"|'[^']*'|\S+)/g, '$1')
    .replace(/-o\s*["']?IdentityFile[= ]\S+/gi, '');
}

/** Path-like tokens: anything between shell/code delimiters that contains a `/` or a `.` or starts with
 *  `~`/`$HOME`. Generous on purpose — a token that isn't a path just never resolves into a root. */
function pathTokens(text: string): string[] {
  const out: string[] = [];
  // Braces are NOT delimiters: `${HOME}/…` must stay one token (a `{a,b}` glob is cut at its magic char).
  for (const m of text.matchAll(/[^\s'"`()<>|&;,=[\]]+/g)) {
    // Trailing sentence punctuation goes (`see /etc/x.`), path dots stay (`../..`).
    const t = m[0].replace(/^file:\/\//, '').replace(/(?<=[\w~])[.:]+$/, '');
    if (!t) continue;
    if (t.includes('/') || t.startsWith('~') || t.startsWith('$') || /\.(?:db|key)(?:-wal|-shm)?$/.test(t) || /^\.[a-z]/i.test(t)) out.push(t);
  }
  return out;
}

/** Expand `~` and `$HOME`; any OTHER variable makes the token unknowable → undefined (skipped). */
function expand(tok: string, home: string): string | undefined {
  let t = tok.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (t.includes('$')) return undefined;
  return t;
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

function clean(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Inside the root, or the root itself — or a sibling FILE sharing its prefix (`agent-os.db-wal`). */
function inside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + '/') || (root.endsWith('.db') && target.startsWith(root));
}

/** macOS automount points (`/home`, `/net`): a `stat` under them blocks ~300 ms on the automounter, and
 *  real homes live under `/Users` there. A remote path inside an ssh one-liner (`/home/app/…`) hit this on
 *  the gate's hot path — 318 ms for one command — so they are resolved lexically only. */
const SLOW_FS = process.platform === 'darwin' ? /^\/(?:home|net|Network)(?:\/|$)/ : null;

function isDir(p: string): boolean {
  if (SLOW_FS?.test(p)) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const realCache = new Map<string, string>();

/** realpath that tolerates a missing leaf: resolve the deepest existing ancestor and re-append the rest.
 *  Memoized (bounded) — the same few directories recur in every command an agent runs. */
function realish(p: string): string {
  if (SLOW_FS?.test(p)) return p;
  const hit = realCache.get(p);
  if (hit !== undefined) return hit;
  let out: string;
  try { out = fs.realpathSync(p); } catch {
    const d = path.dirname(p);
    out = d === p ? p : path.join(realish(d), path.basename(p));
  }
  if (realCache.size > 5000) realCache.clear();
  realCache.set(p, out);
  return out;
}

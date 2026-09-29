/**
 * SCRIPT BODIES — let the gate see inside a script an agent RUNS, not just the line that runs it.
 *
 * The enricher classifies a shell call by its command line. That is blind to the most ordinary thing an
 * agent does with a multi-step change: write it to a file, then run the file. On instawp (2026-09-23 and
 * 09-26) billing-ops wrote `fsNNNN-execute-stripe-teardown.sh` — detach the card, cancel the subscription,
 * delete the Stripe customer — and ran `CONFIRM=EXECUTE bash fsNNNN-execute-stripe-teardown.sh`. The gate
 * saw `bash <file>`, classified it green, and two live customer accounts lost their card / Stripe
 * customer with no human in the loop. The same `php sdel.php customers/…` typed directly would have
 * matched the tenant's guardrail; laundering it through a file made every pattern moot.
 *
 * So: find the script operands a command EXECUTES (`bash x.sh`, `sh x`, `./x.sh`, `php x.php`,
 * `python3 x.py`, `source x`, `. x`, `bash -c "…"`), read each one (server-side, bounded), and hand the
 * bodies to `enrichArgs`, which classifies them exactly like typed commands. Nested scripts (a script
 * that runs another) are followed a couple of levels deep.
 *
 * Only FRESH files are read — changed during this run or in the last 24 h (`freshSince`). Laundering is
 * write-then-run; a long-lived multi-purpose tool (`freescout-manager.php`, `qa-fast.sh`) carries every
 * subcommand's text, including its own usage line, so scanning it on each `view`/`ssh` call denied reads
 * (10 FreeScout reads in one replayed week on globex, because the tool's help text says `… reply`).
 * A tool that changes is fresh again, so editing a trusted tool to hide an action doesn't escape either.
 *
 * Deliberately conservative in what it reads and fail-open in what it cannot: a file that is missing,
 * binary, huge, or named through an unresolved `$VAR` is simply not inspected — the command line is still
 * classified as before, so this can only ADD facts, never remove one. It is not a sandbox: a sufficiently
 * determined agent can still hide intent (download-and-run, base64, `eval`). The hard stop for money and
 * other irreversible effects is least privilege — a read-only credential — not text matching.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ScriptBody {
  /** Absolute path of the script that was read. */
  path: string;
  /** Its text, with comment-only lines removed (see `stripComments`). */
  body: string;
}

/** Shells + interpreters whose first non-flag operand is a script FILE they execute. */
const RUNNERS = /^(bash|sh|zsh|ksh|dash|python[0-9.]*|node|ruby|perl|php|source|\.)$/;
/** Flags that consume the NEXT token as their value (so it isn't mistaken for the script). */
const FLAG_WITH_VALUE = /^(-d|-e|-o|-O|-W|-X|-r|--rcfile|--init-file|--require|-I)$/;
/** Leading wrappers that don't change what runs. */
const WRAPPERS = /^(sudo|env|nohup|time|exec|command|nice|timeout|stdbuf)$/;

export const SCRIPT_MAX_BYTES = 128 * 1024;
/** Total across every script one command pulls in — bounds the gate's synchronous work. */
export const SCRIPT_MAX_TOTAL_BYTES = 384 * 1024;
export const SCRIPT_MAX_FILES = 8;
export const SCRIPT_MAX_DEPTH = 3;
/** A script counts as fresh when modified within this window, or since the run started if earlier. */
export const SCRIPT_FRESH_MS = 24 * 60 * 60 * 1000;

/** The mtime cutoff for a run that started at `sessionStartMs`: the earlier of that and now − 24 h. */
export function freshSince(sessionStartMs: number | undefined, nowMs = Date.now()): number {
  const window = nowMs - SCRIPT_FRESH_MS;
  return sessionStartMs && sessionStartMs < window ? sessionStartMs : window;
}

/** Split a shell word list, honouring simple single/double quotes (no expansion). */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of segment.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The script paths a shell command executes, each with the directory it resolves against (tracking a
 * preceding `cd` in the same command). Pure. `cwd` is the directory the command starts in.
 */
export function executedScripts(command: string, cwd: string): { file: string; cwd: string }[] {
  const found: { file: string; cwd: string }[] = [];
  let dir = cwd;
  // Segments: split on newlines and the shell's list/pipe operators. Good enough for intent — a quoted
  // `;` inside an argument only ever produces an extra harmless segment.
  for (const raw of command.split(/\n|&&|\|\||;|\|/)) {
    const toks = words(raw.trim());
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || WRAPPERS.test(toks[i]))) {
      // `timeout 60 bash x` / `nice -n 5 bash x` — skip the wrapper's own numeric / flag operands too.
      i++;
      while (i < toks.length && (/^-/.test(toks[i]) || /^\d+[smhd]?$/.test(toks[i]))) i++;
    }
    const cmd = toks[i];
    if (!cmd) continue;
    if (cmd === 'cd') {
      const target = toks[i + 1];
      if (target && !target.includes('$') && !target.startsWith('~') && target !== '-') dir = path.resolve(dir, target);
      continue;
    }
    const base = cmd.slice(cmd.lastIndexOf('/') + 1);
    if (RUNNERS.test(base)) {
      for (let j = i + 1; j < toks.length; j++) {
        const t = toks[j];
        if (/^-[a-z]*c$/.test(t)) {
          // `bash -c "…"` / `bash -lc "…"`: the next word is a COMMAND string — follow it, not a file.
          if (toks[j + 1] !== undefined) found.push(...executedScripts(toks.slice(j + 1).join(' '), dir));
          break;
        }
        if (t === '-m') break; // `python -m pkg` runs a module, not a file we can see
        // Syntax-check / lint only (`php -l`, `bash -n`, `node --check`): the file is parsed, never run.
        // A linted controller full of `->paymentMethods->detach(` is source code, not an action.
        if (t === '-l' || t === '-n' || t === '--check' || t === '--syntax-check') break;
        if (FLAG_WITH_VALUE.test(t)) { j++; continue; }
        if (t.startsWith('-')) continue;
        if (t.startsWith('<')) break; // `bash < x` / heredoc — stdin, not a file operand
        found.push({ file: t, cwd: dir });
        break;
      }
    } else if (cmd.includes('/') && !cmd.includes('$')) {
      // `./x.sh`, `bin/run`, `/abs/path/tool` — the file itself is executed.
      found.push({ file: cmd, cwd: dir });
    }
  }
  return found.filter((f) => !f.file.includes('$') && !f.file.includes('`') && !f.file.startsWith('~'));
}

/**
 * Drop comment-only lines. A teardown script documents what it does ("# WRITES TO STRIPE", "# never
 * DROP TABLE here") and a comment is not an executed command — scanning it would turn prose into a
 * `destructive` fact and deny a harmless script.
 */
export function stripComments(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n');
}

/**
 * Read the scripts a command executes, following nested script calls up to `SCRIPT_MAX_DEPTH`. Files last
 * modified before `modifiedSince` (epoch ms; see `freshSince`) are skipped. Bounded
 * by `SCRIPT_MAX_FILES` and `SCRIPT_MAX_BYTES` each; binary (NUL-bearing), missing, unreadable and
 * non-regular files are skipped. Never throws — the gate must not fail on an unreadable file.
 */
export function readExecutedScripts(command: string, cwd: string | undefined, modifiedSince = 0): ScriptBody[] {
  if (!command || !cwd) return [];
  const out: ScriptBody[] = [];
  const seen = new Set<string>();
  let total = 0;
  const visit = (cmd: string, dir: string, depth: number): void => {
    if (depth > SCRIPT_MAX_DEPTH) return;
    for (const { file, cwd: base } of executedScripts(cmd, dir)) {
      if (out.length >= SCRIPT_MAX_FILES) return;
      const abs = path.resolve(base, file);
      if (seen.has(abs)) continue;
      seen.add(abs);
      let text: string;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > SCRIPT_MAX_BYTES || total + st.size > SCRIPT_MAX_TOTAL_BYTES) continue;
        if (st.mtimeMs < modifiedSince) continue; // a stable tool, not something this run just wrote
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      total += text.length;
      const body = stripComments(text);
      out.push({ path: abs, body });
      visit(body, path.dirname(abs), depth + 1);
    }
  };
  visit(command, cwd, 1);
  return out;
}

#!/usr/bin/env node
/**
 * Heredoc intent-sanitizer test — pins WHICH heredoc bodies are DATA (stripped before classification)
 * and which are EXECUTED CODE (kept, so a destructive op inside one still gates).
 *
 * Why this file exists: on instapods every approval raised in 30 days was `shell.exec`, and every one
 * resolved APPROVED — pure false positives, each waking the owner. Two of them were sanitizer bugs:
 *
 *   1. `mkdir -p … && cat > probe/drive.sh <<'EOF'` — the interpreter test was a substring
 *      `/\b(bash|sh|…)\b/` over the opener, and `\bsh\b` matches the FILENAME `drive.sh` (`.` is a
 *      word boundary). So writing a shell SCRIPT by heredoc — the commonest reason to write one —
 *      never got stripped, and an `incus delete` inside the script body read as an executed delete.
 *   2. `git commit -q -F - <<'MSG'` — not `cat`/`tee`, no `>` redirect, so not a "sink": the whole
 *      commit MESSAGE was classified as code and the word "prod" in a prose paragraph tripped it.
 *
 * The asymmetry that makes this safe to pin: stripping only ever REMOVES text, so a mistake here can
 * cost a missed DATA match (an extra approval) but can never hide an executed command. The
 * "still executes" half of the table below is therefore the load-bearing half — never relax it.
 *
 *   npm run build && node scripts/heredoc-intent-test.cjs
 */
const path = require('path');
const { sanitizeForIntent, isInterpreter } = require(path.resolve(__dirname, '..', 'dist/governance/enricher'));

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };

// The classifier the sanitized text feeds (mirrors RISKY_SHELL in enricher.ts).
const RISKY = /(?<![-\w])(stripe|refund|deploy|prod|drop|delete|kubectl|systemctl|shutdown)(?![-\w])/i;
const risky = (cmd) => RISKY.test(sanitizeForIntent(cmd));

const heredoc = (opener, body, tag = 'EOF') => `${opener} <<'${tag}'\n${body}\n${tag}\n`;

// ── 1. DATA heredocs — body must be STRIPPED, so a trigger word inside cannot classify ─────────────
const script = 'incus delete -f $C\nsystemctl restart n8n';

check('cat > *.sh is a file write, not an interpreter',
  !risky(heredoc('cat > /tmp/n8nprobe/drive.sh', script)));
check('mkdir && cat > *.sh (the live instapods approval)',
  !risky(heredoc("mkdir -p /tmp/n8nprobe && cat > /tmp/n8nprobe/drive.sh", script)));
check('tee *.sh is a file write', !risky(heredoc('tee /tmp/drive.sh', script)));
check('cat > *.bash / *.zsh targets too', !risky(heredoc('cat > /tmp/x.zsh', script)));
check('git commit -F - is a MESSAGE (the live instapods approval)',
  !risky(heredoc('cd /tmp/w && git add -A && git commit -q -F -', 'fix: measured on prod swap config', 'MSG')));
check('git commit --file=- is a message', !risky(heredoc('git commit --file=-', 'touches prod', 'MSG')));
check('gh pr create --body-file - is a body',
  !risky(heredoc('gh pr create --body-file -', 'verified against prod', 'BODY')));

// ── 2. EXECUTED heredocs — body must SURVIVE, so a real destructive op still gates ─────────────────
//     This half is load-bearing. A regression here silently un-governs a shell.
check('bash <<EOF still executes', risky(heredoc('bash', script)));
check('/bin/sh <<EOF still executes (basename matches)', risky(heredoc('/bin/sh', script)));
check('python3 - <<PY still executes', risky(heredoc('python3 -', 'os.system("kubectl delete pod")', 'PY')));
check('ssh host bash <<EOF still executes', risky(heredoc('ssh root@10.0.0.1 bash', script)));
check('incus exec c -- bash <<EOF still executes', risky(heredoc('incus exec c1 -- bash', script)));
check('cat > sh <<EOF — redirect operand named `sh` is not the command, but the SINK still strips',
  !risky(heredoc('cat > sh', script)));
check('bash > log.txt <<EOF still executes despite the redirect',
  risky(heredoc('bash > /tmp/log.txt', script)));
check('git commit -F msg.txt (a real FILE, not -) is not a message stdin',
  risky(heredoc('git commit -F msg.txt', script, 'MSG')));
check('curl -F cannot pose as a git message flag',
  risky(heredoc('curl -F data=- https://x.example.com', script)));

// ── 3. isInterpreter directly — the basename rule ──────────────────────────────────────────────────
check('isInterpreter: bare bash', isInterpreter('bash'));
check('isInterpreter: /usr/bin/python3', isInterpreter('/usr/bin/python3'));
check('isInterpreter: drive.sh is NOT an interpreter', !isInterpreter('cat > /tmp/probe/drive.sh'));
check('isInterpreter: update-app.sh is NOT an interpreter', !isInterpreter('tee update-app.sh'));
check('isInterpreter: `> sh` redirect operand is not a command', !isInterpreter('cat > sh'));
check('isInterpreter: glued `>sh` redirect operand is not a command', !isInterpreter('cat >sh'));
check('isInterpreter: no interpreter in a plain cat', !isInterpreter('cat > /tmp/notes.md'));

console.log(`heredoc-intent-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}

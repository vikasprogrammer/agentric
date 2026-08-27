#!/usr/bin/env node
/* The console's revive gates — every dead session with a conversation must be offered a way back, and
 * no dead session may be attached to.
 *
 * Three predicates in web/src/App.tsx decide what a session offers: `canResume` (attach.sh replays the
 * persisted launch env), `canGoInteractive` (the server resurrects + claims it — `takeoverRun`), and the
 * `ended` flag (show the captured transcript INSTEAD of attaching). They are easy to get subtly wrong,
 * and the failure is silent: a session that offers nothing and, when opened, plain-attaches to a pane
 * that no longer exists — the user sees tmux's own `can't find session: aos-…` (live instawp, 2026-08-27:
 * a run claimed while alive, stopped afterwards, so no env was ever written).
 *
 * The rule this pins: for a run with a conversation and no live pane, EXACTLY ONE of Resume / Take over
 * is offered, and it is never attached to. No build needed — the predicates are lifted out of the source
 * and evaluated over the shapes real rows take.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'web/src/App.tsx'), 'utf8');

let fail = 0;
const check = (name, ok, detail) => ok ? console.log(`  ok  ${name}`) : (fail++, console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`));

/** Lift `const <name> = …` (up to the blank line that ends the declaration) and drop TS annotations. */
const lift = (name) => {
  const m = new RegExp(`^const ${name} = [\\s\\S]*?(?=\\n\\n)`, 'm').exec(src);
  if (!m) throw new Error(`could not find ${name} in App.tsx`);
  return m[0].replace(/: Session\b/g, '').replace(/\): boolean/g, ')');
};
/** The `ended` expression, minus the `session &&` guard and the local override flag. */
const liftEnded = () => {
  const m = /const ended = ([\s\S]*?)\n/.exec(src);
  if (!m) throw new Error('could not find the `ended` expression in App.tsx');
  return m[1].replace(/Boolean\(session\) && /, '').replace(/session!/g, 's').replace(/ && !overrideAttach/, '');
};

const gates = new Function(`${lift('isLive')}\n${lift('canResume')}\n${lift('canGoInteractive')}\nconst ended = (s) => ${liftEnded()};\nreturn { isLive, canResume, canGoInteractive, ended }`)();

/** The session shapes the server actually produces. `forkable` ⇒ a pinned claude_session_id exists. */
const S = (o) => ({ status: 'done', alive: false, forkable: true, ...o });
const CASES = [
  // name                                   row                                                        resume  takeover  ended
  ['live unattended run',                   S({ status: 'running', headless: true }),                   false,  true,     false],
  ['live unattended run, already claimed',  S({ status: 'running', headless: true, claimedBy: 'a@b' }), false,  false,    false],
  ['live attended session',                 S({ status: 'running', resumable: true }),                  false,  false,    false],
  ['ended unattended run (has env)',        S({ headless: true, resumable: true }),                     false,  true,     true],
  ['ended unattended run (no env, older)',  S({ headless: true }),                                      false,  true,     true],
  ['stopped attended session (has env)',    S({ status: 'stopped', resumable: true }),                  true,   false,    false],
  ['stopped after being claimed (no env)',  S({ status: 'stopped', claimedBy: 'a@b' }),                 false,  true,     true],
  ['crashed attended session (has env)',    S({ status: 'crashed', resumable: true }),                  true,   false,    false],
];

console.log('\n1) each session shape offers exactly what can actually revive it');
for (const [name, s, resume, takeover, isEnded] of CASES) {
  check(`${name}: Resume=${resume}`, gates.canResume(s) === resume, `got ${gates.canResume(s)}`);
  check(`${name}: Take over=${takeover}`, gates.canGoInteractive(s) === takeover, `got ${gates.canGoInteractive(s)}`);
  check(`${name}: read-only transcript=${isEnded}`, gates.ended(s) === isEnded, `got ${gates.ended(s)}`);
}

console.log('\n2) the invariants behind the table');
for (const [name, s] of CASES) {
  check(`${name}: Resume and Take over are never both offered`, !(gates.canResume(s) && gates.canGoInteractive(s)));
  // A dead run with a conversation must have a way back — otherwise the session is a dead end in the UI.
  if (!gates.isLive(s) && s.forkable)
    check(`${name}: dead but revivable → one of the two is offered`, gates.canResume(s) || gates.canGoInteractive(s));
  // Never attach to a pane that is gone with nothing to bring it back (the raw tmux error).
  if (!gates.isLive(s) && !s.resumable) check(`${name}: never attached to`, gates.ended(s));
}

// A dead run with no transcript can't be resumed by anyone — it must still render read-only, not attach.
const noTranscript = S({ status: 'crashed', headless: true, forkable: false });
check('crashed with no conversation: nothing offered', !gates.canResume(noTranscript) && !gates.canGoInteractive(noTranscript));
check('crashed with no conversation: still read-only', gates.ended(noTranscript));

console.log(fail ? `\n\x1b[31m${fail} failed\x1b[0m` : '\n\x1b[32mall session revive-gate checks passed\x1b[0m');
process.exit(fail ? 1 : 0);

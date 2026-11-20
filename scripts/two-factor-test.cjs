#!/usr/bin/env node
/* Two-factor sign-in test — src/governance/{totp,qr,mfa}.ts + the /accept → /api/auth/2fa/verify flow.
 *
 * What this pins:
 *   - TOTP matches the RFC 6238 vectors, and a used code can't be replayed inside its own window.
 *   - The QR encoder matches `qrencode -l M` bit-for-bit (skipped where qrencode isn't installed).
 *   - Nothing usable at rest: the secret is sealed, recovery codes are hashes.
 *   - A magic link alone NO LONGER signs a 2FA member in: the session it mints is refused by every gate
 *     (/api/auth/me says mfaRequired, /api/state 401s) until a code swaps it for a FRESH full session.
 *   - Guessing is bounded (5 per pending session, then it's gone); a recovery code works exactly once.
 *   - Stripping the second factor needs a code (self) or the right role (admin reset).
 *   - The reminder cadence: every login (per session) and every N days (per member), only while off.
 * Isolated home; no tmux, no ttyd, no network.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-2fa-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { totpAt, totpStep, verifyTotp, base32Encode, base32Decode, normalizeRecoveryCode } = require(path.join(ROOT, 'dist/governance/totp.js'));
const { qrMatrix } = require(path.join(ROOT, 'dist/governance/qr.js'));
const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));

console.log('\n\x1b[1m1) TOTP (RFC 6238 SHA-1 vectors, 6-digit tail)\x1b[0m');
const RFC = base32Encode(Buffer.from('12345678901234567890'));
assert(RFC === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'base32 encodes the RFC seed');
assert(base32Decode(RFC).toString() === '12345678901234567890', 'base32 round-trips');
for (const [t, want] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
  assert(totpAt(RFC, Math.floor(t / 30)) === want, `T=${t} → ${want}`);
}
const now = 1234567890 * 1000;
assert(verifyTotp(RFC, '005924', { nowMs: now }) === Math.floor(1234567890 / 30), 'verify returns the matched step');
assert(verifyTotp(RFC, '005924', { nowMs: now + 30_000 }) != null, 'one step of clock drift is tolerated');
assert(verifyTotp(RFC, '005924', { nowMs: now + 90_000 }) === null, 'three steps late is refused');
assert(verifyTotp(RFC, '005924', { nowMs: now, afterStep: Math.floor(1234567890 / 30) }) === null, 'a code at/below last_step is a replay → refused');
assert(verifyTotp(RFC, '12345', { nowMs: now }) === null && verifyTotp(RFC, 'abcdef', { nowMs: now }) === null, 'malformed codes are refused');
assert(normalizeRecoveryCode(' ABCD efgh ') === 'abcd-efgh' && normalizeRecoveryCode('abcd-efg') === '', 'recovery codes normalise case/spacing, reject wrong length');

console.log('\n\x1b[1m2) QR encoder vs qrencode\x1b[0m');
let haveQrencode = true;
try { execFileSync('qrencode', ['-V'], { stdio: 'ignore' }); } catch { haveQrencode = false; }
if (!haveQrencode) {
  console.log('  (qrencode not installed — skipped)');
} else {
  const samples = ['hi', 'otpauth://totp/Agentric%20(Acme)%3Aowner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Agentric%20(Acme)&algorithm=SHA1&digits=6&period=30', 'x'.repeat(300)];
  for (const t of samples) {
    const ascii = execFileSync('qrencode', ['-l', 'M', '-8', '-m', '0', '-t', 'ASCII', t]).toString().replace(/\n$/, '').split('\n');
    const ref = ascii.map((r) => { const a = []; for (let i = 0; i < r.length; i += 2) a.push(r[i] === '#'); return a; });
    let hit = -1;
    for (let m = 0; m < 8; m++) {
      const mine = qrMatrix(t, m);
      if (mine.length === ref.length && mine.every((row, y) => row.every((v, x) => v === ref[y][x]))) hit = m;
    }
    assert(hit >= 0, `${t.length}-byte payload (v${(ref.length - 17) / 4}) matches qrencode under mask ${hit}`);
  }
}

const registry = new TenantRegistry(ROOT, 0);
registry.bootAll();
const { os: aos } = registry.get('testco');
const owner = aos.team.listMembers().find((m) => m.role === 'owner');
const mk = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const alice = mk('alice@example.com', 'member');
const adam = mk('adam@example.com', 'admin');
const code = (secret, offset = 0) => totpAt(secret, totpStep() + offset);
const clearReplay = (id) => aos.db.prepare('UPDATE member_mfa SET last_step = NULL WHERE member_id = ?').run(id);

console.log('\n\x1b[1m3) Enrolment + storage\x1b[0m');
const setup = aos.mfa.beginSetup(alice.id, alice.email);
assert(/^otpauth:\/\/totp\/.*secret=[A-Z2-7]{32}/.test(setup.uri) && setup.qrSvg.startsWith('<svg'), 'setup returns an otpauth URI + an SVG QR');
assert(!aos.mfa.enabled(alice.id), 'a started setup does not turn 2FA on (no half-enrolled lockout)');
assert(aos.mfa.confirmSetup(alice.id, '000000') === null || code(setup.secret) === '000000', 'a wrong code does not enable');
const enabled = aos.mfa.confirmSetup(alice.id, code(setup.secret));
assert(enabled && enabled.recoveryCodes.length === 10, 'the right code enables and hands back 10 recovery codes');
assert(aos.mfa.enabled(alice.id) && aos.mfa.status(alice.id).recoveryRemaining === 10, 'status reports on + 10 codes');
const row = aos.db.prepare('SELECT * FROM member_mfa WHERE member_id = ?').get(alice.id);
assert(!row.secret.includes(setup.secret) && row.pending_secret === null, 'secret is sealed at rest; pending slot cleared');
assert(!row.recovery.includes(enabled.recoveryCodes[0]) && row.recovery.includes('h1:'), 'recovery codes are stored only as hashes');
assert(!aos.mfa.verify(alice.id, code(setup.secret)).ok, 'the code used to enable cannot be replayed to sign in');

console.log('\n\x1b[1m4) HTTP sign-in flow\x1b[0m');
(async () => {
  const srv = createHttpServer(registry);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const req = async (method, p, cookie, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual', headers: { cookie: cookie || '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie') || '';
    return { status: res.status, body: await res.json().catch(() => ({})), cookie: (setCookie.match(/aos_sid=[^;]*/) || [''])[0] };
  };
  const signInWithLink = async (email) => req('POST', `/accept?token=${aos.team.issueLoginLink(email).token}`, '');

  // a member WITHOUT 2FA: link → full session, reminder due
  const bob = mk('bob@example.com', 'member');
  const b1 = await signInWithLink(bob.email);
  assert(b1.status === 302 && b1.cookie, 'no-2FA member: the link mints a cookie');
  const bMe = await req('GET', '/api/auth/me', b1.cookie);
  assert(bMe.status === 200 && bMe.body.twoFactor && bMe.body.twoFactor.enabled === false, 'no-2FA member is fully signed in');
  assert(bMe.body.twoFactor.nag === true, 'reminder is due on a fresh login (default policy)');
  await req('POST', '/api/me/2fa/nag/dismiss', b1.cookie);
  assert((await req('GET', '/api/auth/me', b1.cookie)).body.twoFactor.nag === false, '"Not now" quiets it for the rest of this login');
  const b2 = await signInWithLink(bob.email);
  assert((await req('GET', '/api/auth/me', b2.cookie)).body.twoFactor.nag === true, 'every-login cadence: a NEW sign-in reminds again');

  // a member WITH 2FA: link → pending session, refused everywhere
  clearReplay(alice.id);
  const a1 = await signInWithLink(alice.email);
  assert(a1.status === 302 && a1.cookie, '2FA member: the link still sets a cookie…');
  const aMe = await req('GET', '/api/auth/me', a1.cookie);
  assert(aMe.status === 401 && aMe.body.mfaRequired === true && aMe.body.email === alice.email, '…but /api/auth/me says a code is owed (still 401 for nginx auth_request)');
  assert((await req('GET', '/api/state', a1.cookie)).status === 401, 'a pending session reaches no member API');
  assert(!aos.team.presence().some((p) => p.memberId === alice.id), 'a pending session does not count as online');
  const wrong = await req('POST', '/api/auth/2fa/verify', a1.cookie, { code: code(setup.secret) === '111111' ? '222222' : '111111' });
  assert(wrong.status === 401 && wrong.body.remaining === 4, 'a wrong code is refused and counted');
  const ok = await req('POST', '/api/auth/2fa/verify', a1.cookie, { code: code(setup.secret) });
  assert(ok.status === 200 && ok.body.via === 'totp' && ok.cookie && ok.cookie !== a1.cookie, 'the right code → a FRESH full session id');
  assert((await req('GET', '/api/auth/me', ok.cookie)).status === 200, 'the new session is signed in');
  assert((await req('GET', '/api/auth/me', a1.cookie)).status === 401 && !(await req('GET', '/api/auth/me', a1.cookie)).body.mfaRequired, 'the pending session id is dead after use');
  assert((await req('GET', '/api/auth/me', ok.cookie)).body.twoFactor.nag === false, 'no reminder once 2FA is on');

  // lockout
  const a2 = await signInWithLink(alice.email);
  let last;
  for (let i = 0; i < 5; i++) last = await req('POST', '/api/auth/2fa/verify', a2.cookie, { code: '000000' === code(setup.secret) ? '999999' : '000000' });
  assert(last.status === 401 && last.body.expired === true, '5 wrong codes destroy the pending session');
  clearReplay(alice.id);
  assert((await req('POST', '/api/auth/2fa/verify', a2.cookie, { code: code(setup.secret) })).status === 401, '…so even the right code no longer works on it');

  // recovery code
  const a3 = await signInWithLink(alice.email);
  const rc = enabled.recoveryCodes[0];
  const viaRc = await req('POST', '/api/auth/2fa/verify', a3.cookie, { code: rc.toUpperCase() });
  assert(viaRc.status === 200 && viaRc.body.via === 'recovery' && viaRc.body.recoveryRemaining === 9, 'a recovery code signs in (case-insensitive) and is burned');
  const a4 = await signInWithLink(alice.email);
  assert((await req('POST', '/api/auth/2fa/verify', a4.cookie, { code: rc })).status === 401, 'the same recovery code does not work twice');

  // self-service: strip needs a code
  const aliceCookie = viaRc.cookie;
  assert((await req('POST', '/api/me/2fa/disable', aliceCookie, { code: '' })).status === 403, 'turning 2FA off without a code is refused (a hijacked cookie alone cannot strip it)');
  assert((await req('POST', '/api/me/2fa/setup', aliceCookie, {})).status === 403, 'moving to a new device without a code is refused');
  clearReplay(alice.id);
  const regen = await req('POST', '/api/me/2fa/recovery', aliceCookie, { code: code(setup.secret) });
  assert(regen.status === 200 && regen.body.recoveryCodes.length === 10 && regen.body.recoveryRemaining === 10, 'regenerating recovery codes (with a code) replaces the set');
  assert(!aos.mfa.verify(alice.id, enabled.recoveryCodes[1]).ok, 'old recovery codes stop working after regeneration');

  // admin reset rules
  const adamCookie = `aos_sid=${aos.team.createSession(adam.id)}`;
  const bobCookie = b2.cookie;
  const ownerCookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  assert((await req('DELETE', `/api/team/${alice.id}/2fa`, bobCookie)).status === 403, 'a member cannot reset anyone');
  // give the owner 2FA so we can test admin→owner refusal
  const os2 = aos.mfa.beginSetup(owner.id, owner.email);
  aos.mfa.confirmSetup(owner.id, code(os2.secret));
  assert((await req('DELETE', `/api/team/${owner.id}/2fa`, adamCookie)).status === 403, 'an admin cannot reset an owner');
  assert((await req('DELETE', `/api/team/${owner.id}/2fa`, ownerCookie)).status === 400, 'nobody resets themselves via the admin route');
  const reset = await req('DELETE', `/api/team/${alice.id}/2fa`, adamCookie);
  assert(reset.status === 200 && !aos.mfa.enabled(alice.id), 'an admin resets a member (lost phone)');
  const a5 = await signInWithLink(alice.email);
  assert((await req('GET', '/api/auth/me', a5.cookie)).status === 200, 'after a reset, the link alone signs them in again');
  const team = await req('GET', '/api/team', ownerCookie);
  assert(Array.isArray(team.body.twoFactor) && team.body.twoFactor.includes(owner.id) && !team.body.twoFactor.includes(alice.id), '/api/team reports who has 2FA on');

  // policy: periodic cadence
  assert((await req('PUT', '/api/settings/two-factor', bobCookie, { nagOnLogin: false })).status === 403, 'members cannot change the reminder policy');
  const pol = await req('PUT', '/api/settings/two-factor', ownerCookie, { nagOnLogin: false, nagEveryDays: 3 });
  assert(pol.status === 200 && pol.body.nagOnLogin === false && pol.body.nagEveryDays === 3, 'owner saves the policy');
  const carol = mk('carol@example.com', 'member');
  const c1 = await signInWithLink(carol.email);
  assert((await req('GET', '/api/auth/me', c1.cookie)).body.twoFactor.nag === true, 'periodic only: never dismissed → due');
  await req('POST', '/api/me/2fa/nag/dismiss', c1.cookie);
  const c2 = await signInWithLink(carol.email);
  assert((await req('GET', '/api/auth/me', c2.cookie)).body.twoFactor.nag === false, 'periodic only: a new login inside the window stays quiet');
  aos.db.prepare('UPDATE member_mfa SET nag_dismissed_at = ? WHERE member_id = ?').run(Date.now() - 4 * 86400_000, carol.id);
  assert((await req('GET', '/api/auth/me', c2.cookie)).body.twoFactor.nag === true, 'periodic: due again after N days, even mid-session');
  await req('PUT', '/api/settings/two-factor', ownerCookie, { nagOnLogin: false, nagEveryDays: 0 });
  assert((await req('GET', '/api/auth/me', c2.cookie)).body.twoFactor.nag === false, 'both cadences off → no reminder');
  const garbage = await req('PUT', '/api/settings/two-factor', ownerCookie, { nagOnLogin: 'yes', nagEveryDays: -5 });
  assert(garbage.body.nagOnLogin === true && garbage.body.nagEveryDays === 0, 'policy input is sanitised (bad bool → default, negative days → 0)');

  // member removal clears the enrolment
  const s3 = aos.mfa.beginSetup(bob.id, bob.email); aos.mfa.confirmSetup(bob.id, code(s3.secret));
  aos.team.removeMember(bob.id);
  assert(!aos.db.prepare('SELECT 1 FROM member_mfa WHERE member_id = ?').get(bob.id), 'removing a member deletes their 2FA row');

  srv.close();
  registry.stopAll();
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); registry.stopAll(); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });

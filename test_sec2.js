// Security checks: strong passwords, lock, 2FA, sign-out everywhere, headers. Run on a fresh server (restart.sh).
const { execSync } = require('child_process'); const crypto = require('crypto');
const B = 'http://localhost:3999'; let pass = 0, fail = 0;
async function call(m, p, b, t, raw) {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  if (raw) return r;
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const ok = (n, c, x) => { c ? pass++ : (fail++, console.log('FAIL', n, JSON.stringify(x || '').slice(0, 220))); };
const psql = q => execSync(`psql -h /tmp -p 5433 -U pguser -d keyarch -At -c "${q}"`).toString().trim();
// own TOTP (RFC 6238) so the test does not rely on the server code
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function dec(s) { let bits = ''; for (const c of s.replace(/\s/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const a = []; for (let i = 0; i + 8 <= bits.length; i += 8) a.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(a); }
function code(secret, step) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', dec(secret)).update(b).digest(); const o = h[19] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); }
const nowStep = () => Math.floor(Date.now() / 30000);
(async () => {
  // headers
  let r = await call('GET', '/', null, null, true);
  // the sandbox uses a tiny stand-in for express/helmet, so header checks only run against the real packages
  if (r.headers.get('x-content-type-options')) {
    ok('CSP report-only header', /default-src 'self'/.test(r.headers.get('content-security-policy-report-only') || ''));
    ok('nosniff header', r.headers.get('x-content-type-options') === 'nosniff');
    ok('permissions-policy', /camera=\(\)/.test(r.headers.get('permissions-policy') || ''));
  } else console.log('(header checks skipped: stand-in express)');
  r = await call('POST', '/api/csp-report', { 'csp-report': { 'blocked-uri': 'x' } }, null, true); ok('csp-report 204', r.status === 204, r.status);

  // company + weak passwords
  const weak = ['short1', 'abcdefgh', '12345678', 'password123', 'qqqqqqqq', 'owner'];
  for (const w of weak) { r = await call('POST', '/api/auth/register-company', { company_name: 'W', admin_full_name: 'W', email: 'w@sec2.co', phone_number: '0712345678', password: w }); ok('register refuses weak ' + w, r.status === 400, r); }
  r = await call('POST', '/api/auth/register-company', { company_name: 'Sec2 Co', admin_full_name: 'Boss', email: 'boss@sec2.co', phone_number: '0712345678', password: 'Mwanza#2026x' }); ok('strong password registers', r.status === 201, r);
  const SA = (await call('POST', '/api/auth/admin-login', { email: 'owner@test.keyarch', password: 'Owner@Test2026' })).body.token;
  const cid = (await call('GET', '/api/platform/companies', null, SA)).body.companies.find(c => c.company_name === 'Sec2 Co').company_id;
  await call('POST', '/api/platform/companies/' + cid + '/payments', { payment_type: 'ONE_TIME', amount: 1500000, plan: 'PRO', method: 'Bank' }, SA);
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x' });
  ok('admin can log in', r.status === 200, r); const A = r.body && r.body.token;
  if (!A) { console.log('cannot continue (company not active)'); process.exit(1); }
  ok('token has session number', JSON.parse(Buffer.from(A.split('.')[1], 'base64').toString()).tv === 0);
  // staff password rules
  for (const w of ['weakpass', 'Short1', 'staff']) { r = await call('POST', '/api/users', { full_name: 'S', email: 'staff@sec2.co', password: w, role: 'VIEWER' }, A); ok('staff weak refused ' + w, r.status === 400, r); }
  r = await call('POST', '/api/users', { full_name: 'Staff', email: 'staff@sec2.co', password: 'Kilimo!Bora77', role: 'VIEWER' }, A); ok('staff created', r.status === 201, r);
  const staffId = r.body.user_id || psql("select user_id from users where email='staff@sec2.co'");

  // lock after 5 wrong
  for (let i = 0; i < 5; i++) { r = await call('POST', '/api/auth/login', { email: 'staff@sec2.co', password: 'wrong' + i }); ok('wrong pw ' + i, r.status === 401, r); }
  r = await call('POST', '/api/auth/login', { email: 'staff@sec2.co', password: 'Kilimo!Bora77' }); ok('locked even with right password', r.status === 429 && r.body.code === 'ACCOUNT_LOCKED', r);
  psql("update users set locked_until = NULL where email='staff@sec2.co'");
  r = await call('POST', '/api/auth/login', { email: 'staff@sec2.co', password: 'Kilimo!Bora77' }); ok('unlocked login ok', r.status === 200, r); const S1 = r.body.token;
  ok('counter reset after success', psql("select failed_logins from users where email='staff@sec2.co'") === '0');

  // password change by admin ends the staff session
  r = await call('GET', '/api/me', null, S1); ok('staff token works', r.status === 200, r);
  r = await call('PUT', '/api/users/' + staffId, { full_name: 'Staff', role: 'VIEWER', password: 'Kilimo!Bora88' }, A); ok('admin changes staff password', r.status === 200, r);
  r = await call('GET', '/api/me', null, S1); ok('old staff token rejected after password change', r.status === 403 && r.body.code === 'SESSION_REVOKED', r);
  r = await call('PUT', '/api/users/' + staffId, { full_name: 'Staff', role: 'VIEWER', password: 'abcdefgh' }, A); ok('admin cannot set weak password', r.status === 400, r);

  // 2FA
  r = await call('GET', '/api/auth/security', null, A); ok('security info', r.status === 200 && r.body.totp_enabled === false && r.body.events.length >= 1, r);
  r = await call('POST', '/api/auth/2fa/setup', { password: 'nope' }, A); ok('2fa setup needs password', r.status === 400, r);
  r = await call('POST', '/api/auth/2fa/setup', { password: 'Mwanza#2026x' }, A); ok('2fa setup', r.status === 200 && /^[A-Z2-7]{32}$/.test(r.body.secret) && /^otpauth:\/\/totp\//.test(r.body.otpauth), r);
  const secret = r.body.secret;
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x' }); ok('not on yet: login still plain', r.status === 200, r);
  r = await call('POST', '/api/auth/2fa/enable', { code: '000000' }, A); ok('enable with wrong code refused', r.status === 400, r);
  const s0 = nowStep();
  r = await call('POST', '/api/auth/2fa/enable', { code: code(secret, s0) }, A); ok('enable with right code', r.status === 200 && r.body.recovery_codes.length === 8, r);
  const rec = r.body.recovery_codes;
  ok('secret stored encrypted', !psql("select totp_secret from users where email='boss@sec2.co'").includes(secret));
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x' }); ok('login asks for code', r.status === 401 && r.body.code === 'TOTP_REQUIRED', r);
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x', code: '123456' }); ok('wrong code refused', r.status === 401 && r.body.code === 'TOTP_INVALID', r);
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'wrongwrong1', code: code(secret, s0) }); ok('wrong password + right code refused', r.status === 401, r);
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x', code: code(secret, s0) }); ok('same code cannot be used twice', r.status === 401, r);
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x', code: code(secret, s0 + 1) }); ok('next code logs in', r.status === 200, r);
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x', code: rec[0] }); ok('recovery code logs in', r.status === 200, r); const A2 = r.body.token;
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x', code: rec[0] }); ok('recovery code works once', r.status === 401, r);
  r = await call('GET', '/api/auth/security', null, A2); ok('recovery codes counted', r.body.totp_enabled === true && r.body.recovery_left === 7, r);

  // super admin / other company cannot be reset by a company admin
  r = await call('POST', '/api/auth/2fa/reset-user', { user_id: 1 }, A2); ok('company admin cannot reset outsiders', r.status === 404, r);

  // sign out everywhere
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x', code: rec[1] }); const A3 = r.body.token;
  r = await call('POST', '/api/auth/logout-all', {}, A3); ok('logout-all', r.status === 200, r);
  for (const [n, t] of [['A2', A2], ['A3', A3]]) { r = await call('GET', '/api/me', null, t); ok('token ' + n + ' dead after logout-all', r.status === 403, r); }

  // turn 2FA off
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x', code: rec[2] }); const A4 = r.body.token; ok('login after logout-all', !!A4, r);
  r = await call('POST', '/api/auth/2fa/disable', { password: 'Mwanza#2026x', code: '000000' }, A4); ok('disable needs right code', r.status === 400, r);
  r = await call('POST', '/api/auth/2fa/disable', { password: 'bad', code: rec[3] }, A4); ok('disable needs right password', r.status === 400, r);
  r = await call('POST', '/api/auth/2fa/disable', { password: 'Mwanza#2026x', code: rec[3] }, A4); ok('disable ok', r.status === 200, r);
  r = await call('POST', '/api/auth/login', { email: 'boss@sec2.co', password: 'Mwanza#2026x' }); ok('plain login after disable', r.status === 200, r);

  // admin resets a colleague's 2FA
  r = await call('POST', '/api/auth/2fa/reset-user', { user_id: Number(staffId) }, A4); ok('admin reset staff 2fa', r.status === 200, r);

  // login history
  r = await call('GET', '/api/auth/security', null, A4); ok('history lists failed and ok', r.body.events.some(e => e.success) && r.body.events.some(e => !e.success), r.body);

  // upload check
  const up = await fetch(B + '/api/import/excel', { method: 'POST', headers: { Authorization: 'Bearer ' + A4, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(500, 65) });
  ok('non-xlsx upload refused', up.status === 400, up.status);

  console.log('SEC2 PASS', pass, 'FAIL', fail);
})().catch(e => { console.log('CRASH', e); process.exit(1); });

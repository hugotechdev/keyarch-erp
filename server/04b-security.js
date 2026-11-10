// SECURITY: strong passwords, account lock, two-step sign-in (2FA), sign-out everywhere, sign-in history
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { app, authenticateToken, allowRoles, bcrypt, clearUserCache, crypto, createAuditLog, pool, rateLimit } = ctx;

    const LOCK_AFTER = parseInt(process.env.LOCK_AFTER_FAILS) || 5;          // wrong tries before the account is locked
    const LOCK_MINUTES = parseInt(process.env.LOCK_MINUTES) || 15;           // how long it stays locked
    const POLICY_ON = String(process.env.PASSWORD_POLICY || 'on').toLowerCase() !== 'off';

    // ---------- 1. STRONG PASSWORDS ----------
    const COMMON = ['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'welcome1', 'welcome123', 'abc12345', 'letmein123', 'changeme', 'keyarch', 'keyarch123', 'tanzania', 'tanzania123', 'passw0rd', 'p@ssw0rd', '11111111', '00000000', 'asdfghjkl'];
    // returns a text describing the problem, or null when the password is fine
    function passwordProblem(pw, email) {
        const p = String(pw == null ? '' : pw);
        if (p.length < 8) return 'Password must be at least 8 characters.';
        if (Buffer.byteLength(p) > 72) return 'Password is too long (maximum 72 characters).';
        if (!POLICY_ON) return null;
        if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must be at least 8 characters and include both letters and numbers.';
        const low = p.toLowerCase();
        if (COMMON.includes(low) || /^(.)\1+$/.test(p)) return 'This password is too common. Please choose a harder one.';
        const local = String(email || '').split('@')[0].toLowerCase();
        if (local.length >= 3 && low.replace(/[0-9!@#$%]+$/, '') === local) return 'The password must not be just your email name.';
        return null;
    }

    // ---------- 2. TWO-STEP SIGN-IN (TOTP, works with Google Authenticator, Microsoft Authenticator, Authy) ----------
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    function b32enc(buf) {
        let bits = '', out = '';
        for (const b of buf) bits += b.toString(2).padStart(8, '0');
        for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
        return out;
    }
    function b32dec(s) {
        let bits = '';
        for (const ch of String(s).replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i >= 0) bits += i.toString(2).padStart(5, '0'); }
        const bytes = [];
        for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
        return Buffer.from(bytes);
    }
    function hotp(key, counter) {
        const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
        const h = crypto.createHmac('sha1', key).update(b).digest();
        const o = h[19] & 15;
        const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
        return String(n % 1000000).padStart(6, '0');
    }
    // returns the 30-second step that matched (so the same code cannot be used twice), or null
    function totpMatch(secretB32, code, lastStep) {
        const c = String(code || '').replace(/\s+/g, '');
        if (!/^\d{6}$/.test(c)) return null;
        const key = b32dec(secretB32), now = Math.floor(Date.now() / 30000);
        for (const d of [0, -1, 1]) {
            const s = now + d;
            if (lastStep && s <= Number(lastStep)) continue;
            const a = Buffer.from(hotp(key, s)), b = Buffer.from(c);
            if (a.length === b.length && crypto.timingSafeEqual(a, b)) return s;
        }
        return null;
    }
    // the secret is stored encrypted (TOTP_KEY, or JWT_SECRET when TOTP_KEY is not set)
    const encKey = crypto.createHash('sha256').update('keyarch-2fa:' + (process.env.TOTP_KEY || process.env.JWT_SECRET)).digest();
    function seal(text) {
        const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
        const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
        return [iv, c.getAuthTag(), ct].map(x => x.toString('base64')).join(':');
    }
    function unseal(blob) {
        try {
            const [iv, tag, ct] = String(blob).split(':').map(x => Buffer.from(x, 'base64'));
            const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv); d.setAuthTag(tag);
            return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
        } catch (e) { return null; }
    }
    const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
    const newRecoveryCodes = () => Array.from({ length: 8 }, () => { const h = crypto.randomBytes(5).toString('hex'); return h.slice(0, 5) + '-' + h.slice(5); });

    // checks the 6-digit code or a recovery code for this user. true = accepted.
    async function verifySecondFactor(user, code) {
        const raw = String(code || '').trim();
        if (!raw || !user.totp_secret) return false;
        const secret = unseal(user.totp_secret);
        if (!secret) return false;
        const step = totpMatch(secret, raw, user.totp_last_step);
        if (step) { await pool.query('UPDATE users SET totp_last_step = $1 WHERE user_id = $2', [step, user.user_id]); return true; }
        // recovery code (each one works once)
        const h = sha(raw.toLowerCase().replace(/\s+/g, ''));
        let list = []; try { list = JSON.parse(user.totp_recovery || '[]'); } catch (e) { list = []; }
        if (list.includes(h)) {
            await pool.query('UPDATE users SET totp_recovery = $1 WHERE user_id = $2', [JSON.stringify(list.filter(x => x !== h)), user.user_id]);
            return true;
        }
        return false;
    }

    // ---------- 3. ACCOUNT LOCK + SIGN-IN HISTORY ----------
    const mins = t => Math.max(1, Math.ceil((new Date(t) - Date.now()) / 60000));
    function lockedMessage(user) {
        return user && user.locked_until && new Date(user.locked_until) > new Date()
            ? `Too many wrong attempts. This account is locked for ${mins(user.locked_until)} more minute(s). Try again later.` : null;
    }
    const clientInfo = req => ({ ip: String(req.ip || '').slice(0, 64), ua: String(req.headers['user-agent'] || '').slice(0, 300) });
    async function event(user, req, ok) {
        const { ip, ua } = clientInfo(req);
        await pool.query('INSERT INTO login_events (user_id, success, ip, user_agent, device_hash) VALUES ($1, $2, $3, $4, $5)', [user.user_id, ok, ip, ua, sha(ua).slice(0, 32)]);
        if (Math.random() < 0.02) await pool.query("DELETE FROM login_events WHERE created_at < NOW() - interval '90 days'");
    }
    function mail(user, subject, text) {
        try {
            if (!ctx.mailConfigured || !ctx.mailConfigured() || !ctx.sendMail || !user.email) return;
            ctx.sendMail(user.email, subject, text).catch(e => console.error('Security mail failed:', e.message));
        } catch (e) { /* mail is optional */ }
    }
    async function failLogin(user, req) {
        try {
            const r = await pool.query('UPDATE users SET failed_logins = COALESCE(failed_logins, 0) + 1 WHERE user_id = $1 RETURNING failed_logins', [user.user_id]);
            await event(user, req, false);
            if (r.rows[0] && r.rows[0].failed_logins >= LOCK_AFTER) {
                await pool.query(`UPDATE users SET failed_logins = 0, locked_until = NOW() + ($1 || ' minutes')::interval WHERE user_id = $2`, [String(LOCK_MINUTES), user.user_id]);
                await createAuditLog(pool, user.company_id, user.user_id, 'Account locked after wrong sign-in attempts', 'AUTH', req.ip, {});
                mail(user, 'KEY ARCH - Security alert / Tahadhari ya usalama',
                    `Habari ${user.full_name},\n\nKumekuwa na majaribio mengi ya kuingia kwenye akaunti yako ya KEY ARCH kwa password isiyo sahihi. Akaunti imefungwa kwa dakika ${LOCK_MINUTES}.\nUkiwa si wewe, badilisha password yako mara moja.\n\nThere were several wrong sign-in attempts on your KEY ARCH account. It is locked for ${LOCK_MINUTES} minutes. If this was not you, change your password now.`);
            }
        } catch (e) { console.error('failLogin:', e.message); }
    }
    async function passLogin(user, req) {
        try {
            const { ua } = clientInfo(req), dev = sha(ua).slice(0, 32);
            const known = (await pool.query('SELECT 1 FROM login_events WHERE user_id = $1 AND success = true AND device_hash = $2 LIMIT 1', [user.user_id, dev])).rows.length > 0;
            const any = (await pool.query('SELECT 1 FROM login_events WHERE user_id = $1 AND success = true LIMIT 1', [user.user_id])).rows.length > 0;
            await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [user.user_id]);
            await event(user, req, true);
            if (any && !known) {
                mail(user, 'KEY ARCH - New sign-in / Umeingia kwa kifaa kipya',
                    `Habari ${user.full_name},\n\nAkaunti yako ya KEY ARCH imeingiwa kutoka kifaa kipya.\nKifaa: ${ua.slice(0, 120) || 'haijulikani'}\nIP: ${req.ip}\nUkiwa si wewe, badilisha password yako na bonyeza "Sign out everywhere" kwenye Settings.\n\nYour KEY ARCH account was signed in from a new device. If this was not you, change your password and use "Sign out everywhere" in Settings.`);
            }
        } catch (e) { console.error('passLogin:', e.message); }
    }

    // ---------- 4. SIGN OUT EVERYWHERE ----------
    // every sign-in token carries the user's "session number". Raising it makes all older tokens useless.
    async function endAllSessions(userId) {
        await pool.query('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE user_id = $1', [userId]);
        clearUserCache(userId);
    }

    // ---------- ROUTES ----------
    const secLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts. Please try again later.' } });
    const me = async req => (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];

    app.get('/api/auth/security', authenticateToken, async (req, res) => {
        try {
            const u = await me(req);
            if (!u) return res.status(404).json({ error: 'Account not found.' });
            let left = 0; try { left = JSON.parse(u.totp_recovery || '[]').length; } catch (e) { /* none */ }
            const ev = (await pool.query('SELECT success, ip, user_agent, created_at FROM login_events WHERE user_id = $1 ORDER BY event_id DESC LIMIT 10', [u.user_id])).rows;
            res.json({ totp_enabled: !!u.totp_enabled, recovery_left: left, events: ev });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/auth/logout-all', authenticateToken, secLimiter, async (req, res) => {
        try {
            await endAllSessions(req.user.user_id);
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Signed out on all devices', 'AUTH', req.ip, {});
            res.json({ message: 'You were signed out on all devices.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // step 1: make a secret (not active yet)
    app.post('/api/auth/2fa/setup', authenticateToken, secLimiter, async (req, res) => {
        try {
            const u = await me(req);
            if (!u) return res.status(404).json({ error: 'Account not found.' });
            if (u.totp_enabled) return res.status(400).json({ error: 'Two-step sign-in is already on.' });
            if (!(await bcrypt.compare(String((req.body || {}).password || ''), u.password_hash))) return res.status(400).json({ error: 'Your password is not correct.' });
            const secret = b32enc(crypto.randomBytes(20));
            await pool.query('UPDATE users SET totp_secret = $1, totp_enabled = false, totp_last_step = NULL WHERE user_id = $2', [seal(secret), u.user_id]);
            const issuer = 'KEY ARCH';
            res.json({ secret, otpauth: `otpauth://totp/${encodeURIComponent(issuer + ':' + u.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30` });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    // step 2: prove the app works with a first code, then switch it on and give recovery codes (shown once)
    app.post('/api/auth/2fa/enable', authenticateToken, secLimiter, async (req, res) => {
        try {
            const u = await me(req);
            if (!u || u.totp_enabled || !u.totp_secret) return res.status(400).json({ error: 'Start the setup first.' });
            const secret = unseal(u.totp_secret);
            const step = secret ? totpMatch(secret, (req.body || {}).code, 0) : null;
            if (!step) return res.status(400).json({ error: 'That code is not correct. Check the time on your phone and try again.' });
            const codes = newRecoveryCodes();
            await pool.query('UPDATE users SET totp_enabled = true, totp_last_step = $1, totp_recovery = $2 WHERE user_id = $3', [step, JSON.stringify(codes.map(c => sha(c))), u.user_id]);
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Two-step sign-in turned on', 'AUTH', req.ip, {});
            res.json({ message: 'Two-step sign-in is on.', recovery_codes: codes });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/auth/2fa/disable', authenticateToken, secLimiter, async (req, res) => {
        try {
            const u = await me(req);
            if (!u || !u.totp_enabled) return res.status(400).json({ error: 'Two-step sign-in is not on.' });
            const b = req.body || {};
            if (!(await bcrypt.compare(String(b.password || ''), u.password_hash))) return res.status(400).json({ error: 'Your password is not correct.' });
            if (!(await verifySecondFactor(u, b.code))) return res.status(400).json({ error: 'That code is not correct.' });
            await pool.query('UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE user_id = $1', [u.user_id]);
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Two-step sign-in turned off', 'AUTH', req.ip, {});
            res.json({ message: 'Two-step sign-in is off.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    // an admin helps a colleague who lost the phone (the company owner for their staff, the platform owner for anyone)
    app.post('/api/auth/2fa/reset-user', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), secLimiter, async (req, res) => {
        try {
            const id = parseInt((req.body || {}).user_id);
            if (!id) return res.status(400).json({ error: 'user_id is required.' });
            const params = [id]; let where = 'user_id = $1';
            if (req.user.role !== 'SUPER_ADMIN') { params.push(req.user.company_id); where += ' AND company_id = $2'; }
            const r = await pool.query(`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL, token_version = COALESCE(token_version, 0) + 1 WHERE ${where} RETURNING user_id`, params);
            if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
            clearUserCache(id);
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Two-step sign-in reset for a user', 'AUTH', req.ip, { target: id });
            res.json({ message: 'Two-step sign-in was reset. The person can set it up again.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    return { endAllSessions, failLogin, lockedMessage, passLogin, passwordProblem, verifySecondFactor };
};

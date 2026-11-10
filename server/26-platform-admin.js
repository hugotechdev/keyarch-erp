// PLATFORM ADMIN (only the Super Admin: all client companies)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { GRACE_DAYS, PORT, SERVER_VERSION, allowRoles, app, authenticateToken, bcrypt, clearAccessCache, clearUserCache, createAuditLog, effectiveFeatures, initDatabase, mailConfigured, pool, runDatabaseSetup, sanitizeFeatures, sendMail, types } = ctx;


    // ============================================================
    // PLATFORM ADMIN (only the Super Admin: all client companies)
    // ============================================================
    const PLATFORM_COMPANIES_SQL = `
        SELECT c.company_id, c.company_name, c.plan, c.access_status, c.billing_type, c.features, c.notes, c.is_active,
               to_char(c.paid_until, 'YYYY-MM-DD') AS paid_until,
               (c.paid_until::date - CURRENT_DATE) AS days_left,
               (c.billing_type = 'SUBSCRIPTION' AND (c.paid_until IS NULL OR c.paid_until::date < CURRENT_DATE - $1::int)) AS expired,
               c.created_at, c.activated_at,
               o.full_name AS owner_name, o.email AS owner_email, o.phone_number AS owner_phone,
               (SELECT COUNT(*) FROM properties p WHERE p.company_id = c.company_id) AS properties,
               (SELECT COUNT(*) FROM units u WHERE u.company_id = c.company_id) AS units,
               (SELECT COUNT(DISTINCT l.tenant_id) FROM leases l WHERE l.company_id = c.company_id AND l.lease_state = 'CURRENT') AS tenants,
               (SELECT COUNT(*) FROM users x WHERE x.company_id = c.company_id AND x.role <> 'COMPANY_ADMIN') AS staff,
               (SELECT MAX(pp.paid_at) FROM platform_payments pp WHERE pp.company_id = c.company_id) AS last_payment
        FROM companies c
        LEFT JOIN LATERAL (
            SELECT full_name, email, phone_number FROM users
            WHERE company_id = c.company_id AND role = 'COMPANY_ADMIN' ORDER BY user_id ASC LIMIT 1
        ) o ON true
        WHERE c.company_id <> $2
        ORDER BY c.company_id DESC`;

    app.get('/api/platform/companies', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        try {
            const rows = (await pool.query(PLATFORM_COMPANIES_SQL, [GRACE_DAYS, req.user.company_id])).rows;
            const received = (await pool.query(
                "SELECT COALESCE(SUM(amount), 0) AS total FROM platform_payments WHERE paid_at >= date_trunc('month', CURRENT_DATE)"
            )).rows[0].total;

            res.json({
                received_this_month: parseFloat(received),
                companies: rows.map(r => ({
                    ...r,
                    features: r.features || {},
                    effective_features: effectiveFeatures(r.plan, r.features),
                    properties: parseInt(r.properties), units: parseInt(r.units),
                    tenants: parseInt(r.tenants), staff: parseInt(r.staff)
                }))
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/platform/companies/:id/payments', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT payment_type, amount, method, reference, months, to_char(period_until, 'YYYY-MM-DD') AS period_until, notes, paid_at
                 FROM platform_payments WHERE company_id = $1 ORDER BY paid_at DESC`,
                [req.params.id]
            );
            res.json(r.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // change status, plan, billing, expiry date, special features and notes
    app.put('/api/platform/companies/:id', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        const { plan, access_status, billing_type, paid_until, features, notes } = req.body;
        if (!['STANDARD', 'PRO'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });
        if (!['PENDING', 'ACTIVE', 'SUSPENDED'].includes(access_status)) return res.status(400).json({ error: 'Invalid status.' });
        const billing = billing_type || null;
        if (billing !== null && !['SUBSCRIPTION', 'ONE_TIME'].includes(billing)) return res.status(400).json({ error: 'Invalid billing type.' });
        const until = paid_until || null;
        if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return res.status(400).json({ error: 'Invalid date.' });

        try {
            const r = await pool.query(
                `UPDATE companies SET plan = $1::varchar, access_status = $2::varchar, billing_type = $3::varchar, paid_until = $4::date,
                        features = $5::jsonb, notes = $6::text,
                        activated_at = CASE WHEN $2::varchar = 'ACTIVE' AND activated_at IS NULL THEN NOW() ELSE activated_at END
                 WHERE company_id = $7 AND company_id <> $8 RETURNING company_id`,
                [plan, access_status, billing, until, JSON.stringify(sanitizeFeatures(features)), notes || null, req.params.id, req.user.company_id]
            );
            if (r.rows.length === 0) return res.status(404).json({ error: 'Company not found.' });
            clearAccessCache(req.params.id);
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Platform: updated company', 'PLATFORM', req.ip, { company_id: req.params.id, plan, access_status });
            res.json({ message: 'Company updated.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // record a payment you received from a client (this also switches access on)
    app.post('/api/platform/companies/:id/payments', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        const { payment_type, amount, method, reference, months, plan, notes } = req.body;
        const types = ['SUBSCRIPTION', 'ONE_TIME', 'MAINTENANCE', 'FEATURE'];
        const amt = parseFloat(amount);
        if (!types.includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type.' });
        if (!(amt > 0)) return res.status(400).json({ error: 'Please enter the amount received.' });
        if (plan && !['STANDARD', 'PRO'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });

        const companyId = req.params.id;
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const comp = (await client.query('SELECT company_id FROM companies WHERE company_id = $1 AND company_id <> $2 FOR UPDATE', [companyId, req.user.company_id])).rows[0];
            if (!comp) throw new Error('Company not found.');

            let m = null, periodUntil = null;
            if (payment_type === 'SUBSCRIPTION') {
                m = Math.max(1, parseInt(months) || 1);
                const upd = await client.query(
                    `UPDATE companies SET billing_type = 'SUBSCRIPTION', access_status = 'ACTIVE',
                            plan = COALESCE($2, plan),
                            paid_until = (GREATEST(COALESCE(paid_until, CURRENT_DATE), CURRENT_DATE) + make_interval(months => $3))::date,
                            activated_at = COALESCE(activated_at, NOW())
                     WHERE company_id = $1 RETURNING to_char(paid_until, 'YYYY-MM-DD') AS paid_until`,
                    [companyId, plan || null, m]
                );
                periodUntil = upd.rows[0].paid_until;
            } else if (payment_type === 'ONE_TIME') {
                await client.query(
                    `UPDATE companies SET billing_type = 'ONE_TIME', access_status = 'ACTIVE', paid_until = NULL,
                            plan = COALESCE($2, 'PRO'), activated_at = COALESCE(activated_at, NOW())
                     WHERE company_id = $1`,
                    [companyId, plan || null]
                );
            }

            await client.query(
                `INSERT INTO platform_payments (company_id, payment_type, amount, method, reference, months, period_until, notes, recorded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [companyId, payment_type, amt, method || null, reference || null, m, periodUntil, notes || null, req.user.user_id]
            );

            await createAuditLog(client, req.user.company_id, req.user.user_id, `Platform: recorded ${payment_type} payment`, 'PLATFORM', req.ip, { company_id: companyId, amount: amt });
            await client.query('COMMIT');
            clearAccessCache(companyId);
            res.status(201).json({ message: 'Payment recorded.', paid_until: periodUntil });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally {
            if (client) client.release();
        }
    });

    // set a new password for the owner of a company (they forgot it)
    app.post('/api/platform/companies/:id/reset-password', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        const { password } = req.body;
        { const pe = ctx.passwordProblem(password, ''); if (pe) return res.status(400).json({ error: pe }); }
        try {
            const owner = (await pool.query(
                "SELECT user_id, email FROM users WHERE company_id = $1 AND role = 'COMPANY_ADMIN' ORDER BY user_id ASC LIMIT 1", [req.params.id]
            )).rows[0];
            if (!owner) return res.status(404).json({ error: 'Owner account not found.' });
            const hashed = await bcrypt.hash(String(password), 10);
            await pool.query('UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1, failed_logins = 0, locked_until = NULL WHERE user_id = $2', [hashed, owner.user_id]);
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Platform: reset owner password', 'PLATFORM', req.ip, { company_id: req.params.id });
            res.json({ message: 'Password changed for ' + owner.email });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });


    // the owner changes their own name, email and password
    app.get('/api/platform/account', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        try {
            const u = (await pool.query('SELECT full_name, email, phone_number FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
            res.json(u || {});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.put('/api/platform/account', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        try {
            const b = req.body || {};
            const cur = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
            if (!cur) return res.status(404).json({ error: 'Account not found.' });
            if (!b.current_password || !(await bcrypt.compare(String(b.current_password), cur.password_hash))) {
                return res.status(400).json({ error: 'Your current password is not correct.' });
            }
            const name = String(b.full_name || cur.full_name).trim().slice(0, 120) || cur.full_name;
            const email = String(b.email || cur.email).trim().toLowerCase();
            if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
            const clash = (await pool.query('SELECT user_id FROM users WHERE LOWER(email) = $1 AND user_id <> $2', [email, cur.user_id])).rows[0];
            if (clash) return res.status(400).json({ error: 'This email is already used by another account.' });
            let hash = cur.password_hash;
            if (b.new_password) {
                { const pe = ctx.passwordProblem(b.new_password, email); if (pe) return res.status(400).json({ error: pe }); }
                hash = await bcrypt.hash(String(b.new_password), 10);
            }
            await pool.query('UPDATE users SET full_name = $1, email = $2, password_hash = $3, phone_number = COALESCE($4, phone_number)' + (b.new_password ? ', token_version = COALESCE(token_version, 0) + 1' : '') + ' WHERE user_id = $5',
                [name, email, hash, b.phone_number ? String(b.phone_number).slice(0, 30) : null, cur.user_id]);
            clearUserCache(cur.user_id);
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Owner changed own account details', 'PLATFORM', req.ip, { email_changed: email !== cur.email, password_changed: !!b.new_password });
            res.json({ message: 'Saved.', full_name: name, email });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });


    // the owner checks that email sending works (forgot password uses it)
    app.post('/api/platform/test-email', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        try {
            if (!mailConfigured()) return res.status(400).json({ error: 'Email is not set up. In Railway > Variables add SMTP_USER (your Gmail address) and SMTP_PASS (a Gmail App Password), then redeploy.' });
            const to = String((req.body || {}).to || '').trim() || (await pool.query('SELECT email FROM users WHERE user_id = $1', [req.user.user_id])).rows[0].email;
            await sendMail(to, 'KEY ARCH - test email', 'This is a test email from KEY ARCH. Email sending works.', '<p>This is a test email from <b>KEY ARCH</b>. Email sending works.</p>');
            res.json({ message: 'Test email sent to ' + to + '. Check the inbox (and Spam).' });
        } catch (err) { res.status(500).json({ error: 'Email failed: ' + (err.response || err.message) }); }
    });

    // run the database setup again and show the result on screen
    app.post('/api/platform/setup-database', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
        try {
            const results = await runDatabaseSetup();
            const failed = results.filter(r => !r.ok).map(r => ({ step: r.step, error: r.error }));
            res.json({ server_version: SERVER_VERSION, total: results.length, failed });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`KEY ARCH SaaS Multi-Tenant Server running on port ${PORT}`);
        initDatabase();
    });

    return {};
};

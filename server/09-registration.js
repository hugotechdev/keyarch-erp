// REGISTRATION (company + staff)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { allowRoles, app, authenticateToken, bcrypt, checkLimit, createAuditLog, pool, rateLimit } = ctx;


    // A logo is sent by the browser as a small PNG/JPEG data URL. Anything else is refused.
    function cleanLogo(v) {
        if (v === undefined) return undefined;          // not sent: leave as it is
        if (v === null || v === '') return null;        // removed
        const str = String(v);
        if (!/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+\/=]+$/.test(str)) { const e = new Error('The logo must be a PNG or JPG picture.'); e.status = 400; throw e; }
        if (str.length > 600000) { const e = new Error('The logo is too big. Use a smaller picture.'); e.status = 400; throw e; }
        return str;
    }
    function canManageTeam(req, res, next) {
        if (req.user.role === 'COMPANY_ADMIN' || req.user.role === 'SUPER_ADMIN' || req.user.can_add_staff) return next();
        return res.status(403).json({ error: 'Access Denied: Unauthorized role permission.' });
    }

    // ============================================================
    // REGISTRATION (company + staff)
    // ============================================================
    const registerLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 10,
        message: { error: 'Too many registrations. Please try again later.' }
    });

    app.post('/api/auth/register-company', registerLimiter, async (req, res) => {
        const { company_name, admin_full_name, email, phone_number, password } = req.body;
        if (!company_name || !admin_full_name || !email || !phone_number || !password) {
            return res.status(400).json({ error: 'Please fill in all required fields.' });
        }
        { const pe = ctx.passwordProblem(password, email); if (pe) return res.status(400).json({ error: pe }); }
        let logo;
        try { logo = cleanLogo(req.body.logo_data); } catch (e) { return res.status(400).json({ error: e.message }); }

        const cleanEmail = String(email).trim().toLowerCase();
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const exists = await client.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [cleanEmail]);
            if (exists.rows.length > 0) throw new Error('This email is already registered.');

            const comp = await client.query(
                "INSERT INTO companies (company_name, subscription_plan, plan, access_status, billing_type) VALUES ($1, 'BASIC', 'STANDARD', 'PENDING', NULL) RETURNING company_id",
                [String(company_name).trim()]
            );
            const companyId = comp.rows[0].company_id;
            if (logo) await client.query('UPDATE companies SET logo_data = $1 WHERE company_id = $2', [logo, companyId]);

            const hashed = await bcrypt.hash(String(password), 10);
            await client.query(
                'INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [companyId, String(admin_full_name).trim(), cleanEmail, hashed, phone_number, 'COMPANY_ADMIN', true, true]
            );

            await createAuditLog(client, companyId, null, 'Company Registered', 'AUTH', req.ip, { email: cleanEmail });
            await client.query('COMMIT');
            res.status(201).json({ message: 'Company registered. Access starts after your payment is confirmed.' });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally {
            if (client) client.release();
        }
    });

    app.post('/api/auth/register-staff', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), async (req, res) => {
        const { full_name, email, password, role } = req.body;
        const allowed = ['PROPERTY_MANAGER', 'ACCOUNTANT', 'MAINTENANCE_MANAGER', 'VIEWER'];
        if (!full_name || !email || !password) return res.status(400).json({ error: 'Please fill in all required fields.' });
        { const pe = ctx.passwordProblem(password, email); if (pe) return res.status(400).json({ error: pe }); }
        if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
        const staffLimit = await checkLimit(req.user, 'max_staff', "SELECT COUNT(*) FROM users WHERE company_id = $1 AND role <> 'COMPANY_ADMIN'", 'staff members');
        if (staffLimit) return res.status(403).json({ error: staffLimit, code: 'LIMIT_REACHED' });

        const cleanEmail = String(email).trim().toLowerCase();
        try {
            const exists = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [cleanEmail]);
            if (exists.rows.length > 0) return res.status(400).json({ error: 'This email is already registered.' });

            const hashed = await bcrypt.hash(String(password), 10);
            await pool.query(
                'INSERT INTO users (company_id, full_name, email, password_hash, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [req.user.company_id, String(full_name).trim(), cleanEmail, hashed, role, true, false]
            );
            await createAuditLog(pool, req.user.company_id, req.user.user_id, `Registered staff (${role})`, 'USERS', req.ip, { email: cleanEmail });
            res.status(201).json({ message: 'Staff registered successfully.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/staff', authenticateToken, canManageTeam, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT user_id, full_name, email, role, is_active FROM users WHERE company_id = $1 ORDER BY full_name ASC',
                [req.user.company_id]
            );
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    return { canManageTeam, cleanLogo };
};

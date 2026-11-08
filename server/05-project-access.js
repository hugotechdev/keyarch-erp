// PROJECT ACCESS (Pro): a person can be limited to some projects (properties)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { JWT_SECRET, accessBlock, app, bcrypt, companyInfo, createAuditLog, getCompanyAccess, jwt, loginLimiter, pool, superAdminCompanyInfo } = ctx;


    // ============================================================
    // PROJECT ACCESS (Pro): a person can be limited to some projects (properties)
    //   req.user.scope === null  -> sees everything in the company
    //   req.user.scope === [..]  -> sees only these property ids
    // ============================================================
    const scoped = req => Array.isArray(req.user.scope);
    // adds "AND <col> = ANY($n)" when the person is limited; params is the query parameter array
    function scopeSql(req, col, params) {
        if (!scoped(req)) return '';
        params.push(req.user.scope.length ? req.user.scope : [0]);
        return ` AND ${col} = ANY($${params.length}::int[])`;
    }
    function inScope(req, propertyId) {
        if (!scoped(req)) return true;
        return propertyId !== null && propertyId !== undefined && req.user.scope.map(String).includes(String(propertyId));
    }
    // finds the property id(s) behind a record
    async function propertiesOf(kind, id, cId) {
        const q = {
            property: ['SELECT property_id FROM properties WHERE property_id = $1 AND company_id = $2'],
            unit: ['SELECT property_id FROM units WHERE unit_id = $1 AND company_id = $2'],
            lease: ['SELECT u.property_id FROM leases l JOIN units u ON u.unit_id = l.unit_id WHERE l.lease_id = $1 AND l.company_id = $2'],
            tenant: ['SELECT DISTINCT u.property_id FROM leases l JOIN units u ON u.unit_id = l.unit_id WHERE l.tenant_id = $1 AND l.company_id = $2'],
            invoice: ['SELECT u.property_id FROM invoices i JOIN leases l ON l.lease_id = i.lease_id JOIN units u ON u.unit_id = l.unit_id WHERE i.invoice_id = $1 AND i.company_id = $2'],
            payment: ['SELECT u.property_id FROM payments py JOIN invoices i ON i.invoice_id = py.invoice_id JOIN leases l ON l.lease_id = i.lease_id JOIN units u ON u.unit_id = l.unit_id WHERE py.payment_id = $1 AND py.company_id = $2'],
            expense: ['SELECT property_id FROM expenses WHERE expense_id = $1 AND company_id = $2'],
            ticket: ['SELECT COALESCE(w.property_id, u.property_id) AS property_id FROM work_orders w LEFT JOIN units u ON u.unit_id = w.unit_id WHERE w.ticket_id = $1 AND COALESCE(w.company_id, u.company_id) = $2']
        }[kind];
        if (!q || id === undefined || id === null || id === '') return [];
        const r = await pool.query(q[0], [id, cId]);
        return r.rows.map(x => x.property_id);
    }
    // true when the person may touch this record. Sends the error itself when not.
    async function guard(req, res, kind, id) {
        if (!scoped(req)) return true;
        let ids;
        try { ids = await propertiesOf(kind, id, req.user.company_id); } catch (e) { ids = []; }
        // a record that belongs to no project at all (for example a general expense) is company level: not for limited people
        if (ids.length && ids.every(p => inScope(req, p))) return true;
        res.status(403).json({ error: 'You do not have access to this project.', code: 'OUT_OF_SCOPE' });
        return false;
    }
    // routes that cannot be split by project: only people who see the whole company may use them
    function companyWide(req, res, next) {
        if (scoped(req)) return res.status(403).json({ error: 'This page is for people who can see all projects.', code: 'OUT_OF_SCOPE' });
        next();
    }

    // 1. AUTHENTICATION
    // the owner of the system signs in on its own page (/admin) and nowhere else
    app.post('/api/auth/admin-login', loginLimiter, (req, res, next) => { req.isOwnerLogin = true; next(); }, (req, res, next) => loginHandler(req, res, next));
    app.post('/api/auth/login', loginLimiter, (req, res, next) => loginHandler(req, res, next));
    async function loginHandler(req, res) {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and Password are required.' });

        try {
            const userQuery = await pool.query(
                `SELECT u.*, c.company_name
                 FROM users u
                 LEFT JOIN companies c ON u.company_id = c.company_id
                 WHERE LOWER(u.email) = LOWER($1)`,
                [email]
            );
            if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Invalid Email or Password.' });

            const user = userQuery.rows[0];
            if (req.isOwnerLogin && user.role !== 'SUPER_ADMIN') return res.status(401).json({ error: 'Invalid Email or Password.' });
            const isPasswordValid = await bcrypt.compare(password, user.password_hash);
            if (!isPasswordValid) return res.status(401).json({ error: 'Invalid Email or Password.' });

            if (!user.is_active) return res.status(403).json({ error: 'Account suspended.', code: 'ACCOUNT_SUSPENDED' });
            if (user.role === 'SUPER_ADMIN' && !req.isOwnerLogin) return res.status(403).json({ error: 'Invalid Email or Password.' });

            let company;
            if (user.role === 'SUPER_ADMIN') {
                company = superAdminCompanyInfo(user.company_name);
            } else {
                const access = await getCompanyAccess(user.company_id);
                const block = accessBlock(access);
                if (block) return res.status(403).json({ error: block.message, code: block.code });
                company = companyInfo(access);
            }

            const token = jwt.sign(
                { user_id: user.user_id, company_id: user.company_id, email: user.email, role: user.role, full_name: user.full_name, can_edit_tenants: user.can_edit_tenants },
                JWT_SECRET,
                { expiresIn: '12h' }
            );

            await createAuditLog(pool, user.company_id, user.user_id, `User Logged In`, 'AUTH', req.ip, { email: user.email });

            res.json({
                message: 'Login successful',
                token,
                user: { user_id: user.user_id, company_id: user.company_id, company_name: user.company_name, full_name: user.full_name, email: user.email, role: user.role, can_edit_tenants: user.can_edit_tenants },
                company
            });
        } catch (err) {
            console.error('Login Error:', err);
            res.status(500).json({ error: 'Server error during login: ' + err.message });
        }
    }
    return { companyWide, guard, inScope, propertiesOf, scopeSql, scoped };
};

// COMPANY PROFILE + FINANCIAL YEAR (printed on invoices, receipts and reports)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_ADMIN, allowRoles, app, authenticateToken, cleanLogo, clearAccessCache, createAuditLog, pool, wrapAsync } = ctx;


    // ============================================================
    // COMPANY PROFILE + FINANCIAL YEAR (printed on invoices, receipts and reports)
    // ============================================================
    app.get('/api/company/profile', authenticateToken, wrapAsync(async (req, res) => {
        const r = await pool.query(
            `SELECT company_name, address, phone, email, tin, payment_instructions, COALESCE(fy_start_month, 1) AS fy_start_month,
                    COALESCE(luku_low_threshold, 5) AS luku_low_threshold, logo_data
             FROM companies WHERE company_id = $1`, [req.user.company_id]
        );
        res.json(r.rows[0] || {});
    }));

    app.put('/api/company/profile', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
        const { company_name, address, phone, email, tin, payment_instructions } = req.body;
        let logo;
        try { logo = cleanLogo(req.body.logo_data); } catch (e) { return res.status(400).json({ error: e.message }); }
        const fy = parseInt(req.body.fy_start_month);
        const low = parseInt(req.body.luku_low_threshold);
        if (!company_name || !String(company_name).trim()) return res.status(400).json({ error: 'Company name is required.' });
        if (!(fy >= 1 && fy <= 12)) return res.status(400).json({ error: 'Choose the month your financial year starts.' });
        await pool.query(
            `UPDATE companies SET company_name = $1, address = $2, phone = $3, email = $4, tin = $5, payment_instructions = $6,
                    fy_start_month = $7, luku_low_threshold = $8
             WHERE company_id = $9`,
            [String(company_name).trim(), address || null, phone || null, email || null, tin || null, payment_instructions || null,
             fy, low >= 0 ? low : 5, req.user.company_id]
        );
        if (logo !== undefined) await pool.query('UPDATE companies SET logo_data = $1 WHERE company_id = $2', [logo, req.user.company_id]);
        clearAccessCache(req.user.company_id);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Updated company profile', 'SETTINGS', req.ip, {});
        res.json({ message: 'Company details saved.' });
    }));
    return {};
};

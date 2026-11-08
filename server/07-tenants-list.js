// TENANTS: one row per tenant (their current / latest lease)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_VIEW_MONEY, allowRoles, app, authenticateToken, guard, pool, scopeSql } = ctx;


    // ============================================================
    // TENANTS: one row per tenant (their current / latest lease)
    // ============================================================
    const LEASE_MANAGERS = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'];

    app.get('/api/tenants', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        try {
            const tparams = [req.user.company_id];
            const tsc = scopeSql(req, 'p.property_id', tparams);
            const result = await pool.query(
                `SELECT * FROM (
                    SELECT DISTINCT ON (t.tenant_id)
                           t.*, COALESCE(t.is_active, true) AS tenant_active,
                           l.lease_id, l.start_date, l.end_date, l.lease_state, l.agreed_rent,
                           l.rent_price, l.rent_period, l.number_of_periods, l.total_rent, COALESCE(l.discount, 0) AS discount,
                           COALESCE(l.total_to_pay, l.agreed_rent) AS total_to_pay, l.payment_status,
                           COALESCE(l.amount_paid, 0) AS amount_paid, COALESCE(l.amount_due, l.agreed_rent) AS amount_due,
                           (l.end_date::date - CURRENT_DATE) AS days_left,
                           u.unit_id, u.unit_number, COALESCE(u.service_charge, 0) AS service_charge, COALESCE(u.service_inclusive, false) AS service_inclusive,
                           p.property_id, COALESCE(p.property_name, p.title) AS property_name,
                           (SELECT COUNT(*) FROM payments py JOIN invoices i4 ON py.invoice_id = i4.invoice_id JOIN leases l4 ON i4.lease_id = l4.lease_id
                             WHERE l4.tenant_id = t.tenant_id AND py.company_id = $1) AS payment_count,
                           (SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0)
                              FROM invoices_tzs inv JOIN leases l2 ON inv.lease_id = l2.lease_id
                             WHERE l2.tenant_id = t.tenant_id AND inv.company_id = $1) AS balance_owed,
                           (SELECT COUNT(*) FROM leases l3 WHERE l3.tenant_id = t.tenant_id) AS lease_count
                    FROM tenants t
                    JOIN leases l ON t.tenant_id = l.tenant_id
                    JOIN units u ON l.unit_id = u.unit_id
                    JOIN properties p ON u.property_id = p.property_id
                    WHERE t.company_id = $1 ${tsc}
                    ORDER BY t.tenant_id, (l.lease_state = 'CURRENT') DESC, l.lease_id DESC
                 ) x
                 ORDER BY (x.lease_state = 'CURRENT') DESC, x.tenant_id DESC`,
                tparams
            );
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // FULL HISTORY OF ONE TENANT (all leases, invoices, payments, activity)
    app.get('/api/tenants/:id/history', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        if (!(await guard(req, res, 'tenant', req.params.id))) return;
        const cId = req.user.company_id;
        const tenantId = req.params.id;
        try {
            const tenantRes = await pool.query('SELECT * FROM tenants WHERE tenant_id = $1 AND company_id = $2', [tenantId, cId]);
            if (tenantRes.rows.length === 0) return res.status(404).json({ error: 'Tenant not found.' });

            const leases = (await pool.query(
                `SELECT l.*, to_char(l.start_date, 'YYYY-MM-DD') AS start_str, to_char(l.end_date, 'YYYY-MM-DD') AS end_str,
                        (l.end_date::date - CURRENT_DATE) AS days_left,
                        u.unit_number, COALESCE(p.property_name, p.title) AS property_name
                 FROM leases l JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                 WHERE l.tenant_id = $1 AND l.company_id = $2 ORDER BY l.lease_id DESC`,
                [tenantId, cId]
            )).rows;

            const invoices = (await pool.query(
                `SELECT inv.invoice_id, inv.invoice_number, inv.amount_due, inv.due_date, inv.lease_id, inv.invoice_type, inv.description, inv.issue_date, COALESCE(pay.paid, 0) AS paid
                 FROM invoices inv JOIN leases l ON inv.lease_id = l.lease_id
                 LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
                 WHERE l.tenant_id = $1 AND inv.company_id = $2 ORDER BY inv.invoice_id DESC`,
                [tenantId, cId]
            )).rows;

            const payments = (await pool.query(
                `SELECT pay.payment_id, pay.receipt_number, pay.amount_paid, pay.payment_date, pay.payment_method, pay.method_detail, pay.reference_no, inv.invoice_id, inv.invoice_number, inv.invoice_type, COALESCE(pay.currency, inv.currency, l.currency) AS currency
                 FROM payments pay JOIN invoices inv ON pay.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
                 WHERE l.tenant_id = $1 AND pay.company_id = $2 ORDER BY pay.payment_date DESC`,
                [tenantId, cId]
            )).rows;

            let events = [];
            try {
                events = (await pool.query(
                    'SELECT event_type, description, amount, created_at FROM lease_events WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC',
                    [tenantId, cId]
                )).rows;
            } catch (e) { console.error('History events warning:', e.message); }

            const billed = invoices.reduce((s, i) => s + parseFloat(i.amount_due), 0);
            const paid = invoices.reduce((s, i) => s + parseFloat(i.paid), 0);
            const balance = invoices.reduce((s, i) => s + Math.max(0, parseFloat(i.amount_due) - parseFloat(i.paid)), 0);

            res.json({ tenant: tenantRes.rows[0], leases, invoices, payments, events, totals: { billed, paid, balance } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    return { LEASE_MANAGERS };
};

// SERVICE CHARGES (fixed monthly amount per unit: security, garbage, water pump...)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_MONEY, R_VIEW_MONEY, allowRoles, app, authenticateToken, createAuditLog, createInvoice, inScope, isDateStr, monthLabel, monthRange, pool, scopeSql, todayStr, wrapAsync } = ctx;


    async function loadServiceStatus(cId, ym, propertyId, req) {
        const range = monthRange(ym);
        const params = [cId, range.start];
        let extra = '';
        if (propertyId) { params.push(propertyId); extra = ` AND u.property_id = $${params.length}`; }
        if (req) extra += scopeSql(req, 'u.property_id', params);
        const rows = (await pool.query(
            `SELECT u.unit_id, u.unit_number, u.property_id, COALESCE(p.property_name, p.title) AS property_name,
                    COALESCE(u.service_charge, 0) AS service_charge, COALESCE(u.service_inclusive, false) AS service_inclusive,
                    l.lease_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
                    sv.invoice_id, sv.amount, sv.balance
             FROM units u
             JOIN properties p ON p.property_id = u.property_id
             JOIN leases l ON l.unit_id = u.unit_id AND l.lease_state = 'CURRENT'
             JOIN tenants t ON t.tenant_id = l.tenant_id
             LEFT JOIN LATERAL (
                 SELECT inv.invoice_id, inv.amount_due AS amount,
                        inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments py WHERE py.invoice_id = inv.invoice_id), 0) AS balance
                 FROM invoices inv WHERE inv.lease_id = l.lease_id AND inv.invoice_type = 'SERVICE' AND inv.period_start = $2::date
                 ORDER BY inv.invoice_id DESC LIMIT 1
             ) sv ON true
             WHERE u.company_id = $1 AND u.status = 'OCCUPIED' AND COALESCE(u.service_charge, 0) > 0 ${extra}
             ORDER BY property_name, u.unit_number`, params
        )).rows;
        const items = rows.map(r => {
            let status;
            if (r.service_inclusive) status = 'INCLUSIVE';
            else if (r.amount === null) status = 'NOT_BILLED';
            else if (parseFloat(r.balance) <= 0) status = 'PAID';
            else status = parseFloat(r.balance) < parseFloat(r.amount) ? 'PARTIAL' : 'UNPAID';
            return { ...r, status };
        });
        const count = (st) => items.filter(i => i.status === st).length;
        return {
            month: ym,
            summary: {
                units: items.filter(i => i.status !== 'INCLUSIVE').length,
                paid: count('PAID'), partial: count('PARTIAL'), unpaid: count('UNPAID'), not_billed: count('NOT_BILLED'), inclusive: count('INCLUSIVE'),
                not_paid_total: count('PARTIAL') + count('UNPAID') + count('NOT_BILLED')
            },
            items
        };
    }

    app.get('/api/service-charges/status', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const ym = req.query.month || todayStr().slice(0, 7);
        if (!monthRange(ym)) return res.status(400).json({ error: 'Invalid month.' });
        if (req.query.property_id && !inScope(req, req.query.property_id)) return res.status(403).json({ error: 'You do not have access to this project.', code: 'OUT_OF_SCOPE' });
        res.json(await loadServiceStatus(req.user.company_id, ym, req.query.property_id, req));
    }));

    // creates the service-charge invoice of a month for every occupied unit that has one (never twice)
    app.post('/api/service-charges/generate', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
        const ym = req.body.month || todayStr().slice(0, 7);
        const range = monthRange(ym);
        if (!range) return res.status(400).json({ error: 'Invalid month.' });
        const cId = req.user.company_id;
        const due = isDateStr(req.body.due_date) ? req.body.due_date : new Date(Date.UTC(parseInt(ym.slice(0, 4)), parseInt(ym.slice(5, 7)) - 1, 7)).toISOString().slice(0, 10);

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const params = [cId, range.start, range.end];
            let extra = '';
            if (req.body.property_id) { params.push(req.body.property_id); extra = ` AND u.property_id = $${params.length}`; }
            extra += scopeSql(req, 'u.property_id', params);
            const leases = (await client.query(
                `SELECT l.lease_id, COALESCE(l.service_amount, u.service_charge) AS service_charge, COALESCE(p.service_charge_label, 'Service charge') AS label
                 FROM leases l JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
                 WHERE l.company_id = $1 AND l.lease_state = 'CURRENT' AND COALESCE(u.service_charge, 0) > 0 AND COALESCE(u.service_inclusive, false) = false
                   AND l.start_date <= $3::date AND l.end_date >= $2::date ${extra}
                   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id = l.lease_id AND i.invoice_type = 'SERVICE' AND i.period_start = $2::date)`, params
            )).rows;
            for (const l of leases) {
                await createInvoice(client, {
                    companyId: cId, leaseId: l.lease_id, type: 'SERVICE', subtotal: l.service_charge, discount: 0,
                    description: `${l.label} - ${monthLabel(ym)}`, dueDate: due, periodStart: range.start, periodEnd: range.end,
                    leaseCharge: false, userId: req.user.user_id
                });
            }
            await createAuditLog(client, cId, req.user.user_id, 'Generated service charges', 'INVOICES', req.ip, { month: ym, created: leases.length });
            await client.query('COMMIT');
            res.status(201).json({ message: leases.length ? `${leases.length} service charge invoice(s) created for ${monthLabel(ym)}.` : `All service charges for ${monthLabel(ym)} were already created.`, created: leases.length });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally { if (client) client.release(); }
    }));


    app.get('/api/leases', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        try {
            const params = [req.user.company_id];
            const result = await pool.query(
                `SELECT l.*, t.full_name AS tenant_name, u.unit_number
                 FROM leases l JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id
                 WHERE l.company_id = $1 ${scopeSql(req, 'u.property_id', params)} ORDER BY l.lease_id DESC`,
                params
            );
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    return { loadServiceStatus };
};

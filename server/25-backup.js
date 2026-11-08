// BACKUP (everything the company has, as one Excel file)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_ADMIN, allowRoles, app, authenticateToken, createAuditLog, effectiveFeatures, getCompanyAccess, niceDate, pool, todayStr, writeWorkbookTo } = ctx;


    // ============================================================
    // BACKUP (everything the company has, as one Excel file)
    // Standard plan: tenants + payments.  Pro plan: all data.
    // ============================================================
    app.get('/api/backup/export', authenticateToken, allowRoles(...R_ADMIN), async (req, res) => {
        try {
            const cId = req.user.company_id;
            let full = req.user.role === 'SUPER_ADMIN';
            if (!full) {
                const a = await getCompanyAccess(cId);
                full = !!effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null).backup_full;
            }
            const text = (k, l, extra) => ({ key: k, label: l, type: 'text', ...(extra || {}) });
            const money = (k, l) => ({ key: k, label: l, type: 'money' });
            const date = (k, l) => ({ key: k, label: l, type: 'date' });
            const q = async (sql) => (await pool.query(sql, [cId])).rows.map(r => { const o = {}; Object.keys(r).forEach(k => { o[k] = r[k] instanceof Date ? r[k].toISOString().slice(0, 10) : (r[k] === null ? '' : r[k]); }); return o; });

            const sheets = [];
            sheets.push({ name: 'Tenants', columns: [text('name', 'Name'), text('phone', 'Phone'), text('id_type', 'ID type'), text('id_no', 'ID number'), text('property', 'Property'), text('unit', 'Unit'), text('status', 'Status'), date('start', 'Start'), date('end', 'End'), money('total', 'Contract total')],
                rows: await q(`SELECT * FROM (SELECT DISTINCT ON (t.tenant_id) t.full_name AS name, t.phone_number AS phone, t.identity_type AS id_type, t.nida_passport_no AS id_no,
                        COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit, l.lease_state AS status, to_char(l.start_date,'YYYY-MM-DD') AS start, to_char(l.end_date,'YYYY-MM-DD') AS "end",
                        COALESCE(l.total_to_pay, l.agreed_rent, 0) AS total
                     FROM tenants t LEFT JOIN leases l ON l.tenant_id = t.tenant_id LEFT JOIN units u ON u.unit_id = l.unit_id LEFT JOIN properties p ON p.property_id = u.property_id
                     WHERE t.company_id = $1 ORDER BY t.tenant_id, (l.lease_state = 'CURRENT') DESC, l.lease_id DESC) x ORDER BY name`) });
            sheets.push({ name: 'Payments', columns: [date('date', 'Date'), text('receipt', 'Receipt'), text('tenant', 'Tenant'), text('invoice', 'Invoice'), text('method', 'Method'), text('reference', 'Reference'), money('amount', 'Amount')],
                rows: await q(`SELECT to_char(py.payment_date,'YYYY-MM-DD') AS date, py.receipt_number AS receipt, t.full_name AS tenant, inv.invoice_number AS invoice, COALESCE(py.method_detail, py.payment_method) AS method, py.reference_no AS reference, py.amount_paid AS amount
                     FROM payments py JOIN invoices inv ON inv.invoice_id = py.invoice_id JOIN leases l ON l.lease_id = inv.lease_id JOIN tenants t ON t.tenant_id = l.tenant_id
                     WHERE py.company_id = $1 ORDER BY py.payment_date`) });
            if (full) {
                sheets.push({ name: 'Properties', columns: [text('name', 'Property'), text('address', 'Address'), text('category', 'Type'), text('unit', 'Unit'), money('rent', 'Rent'), money('service', 'Service charge'), text('status', 'Status')],
                    rows: await q(`SELECT COALESCE(p.property_name, p.title) AS name, p.address, p.category, u.unit_number AS unit, u.rent_amount AS rent, COALESCE(u.service_charge,0) AS service, u.status
                         FROM properties p LEFT JOIN units u ON u.property_id = p.property_id WHERE p.company_id = $1 ORDER BY p.property_id, u.unit_number`) });
                sheets.push({ name: 'Invoices', columns: [date('issued', 'Issued'), text('invoice', 'Invoice'), text('tenant', 'Tenant'), text('type', 'Type'), text('description', 'Description', { wide: true }), money('total', 'Total'), date('due', 'Due')],
                    rows: await q(`SELECT to_char(COALESCE(inv.issue_date, inv.created_at::date),'YYYY-MM-DD') AS issued, inv.invoice_number AS invoice, t.full_name AS tenant, inv.invoice_type AS type, COALESCE(inv.description,'') AS description, inv.amount_due AS total, to_char(inv.due_date,'YYYY-MM-DD') AS due
                         FROM invoices inv JOIN leases l ON l.lease_id = inv.lease_id JOIN tenants t ON t.tenant_id = l.tenant_id WHERE inv.company_id = $1 ORDER BY inv.invoice_id`) });
                let exp = [];
                try { exp = await q(`SELECT to_char(e.expense_date,'YYYY-MM-DD') AS date, e.category, e.description, COALESCE(p.property_name, p.title,'') AS property, COALESCE(e.payee,'') AS payee, e.amount FROM expenses e LEFT JOIN properties p ON p.property_id = e.property_id WHERE e.company_id = $1 ORDER BY e.expense_date`); } catch (e) { /* optional */ }
                sheets.push({ name: 'Expenses', columns: [date('date', 'Date'), text('category', 'Category'), text('description', 'Description', { wide: true }), text('property', 'Property'), text('payee', 'Paid to'), money('amount', 'Amount')], rows: exp });
            }
            sheets.forEach(s => s.rows = s.rows.map(r => { const o = { ...r }; s.columns.forEach(c => { if (c.type === 'money') o[c.key] = parseFloat(o[c.key]) || 0; else o[c.key] = o[c.key] === undefined ? '' : String(o[c.key]); }); return o; }));
            const company = (await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [cId])).rows[0] || {};
            sheets.forEach(s => s.heading = [company.company_name || '', `Backup - ${s.name}`, `Created ${niceDate(todayStr())}`]);
            await createAuditLog(pool, cId, req.user.user_id, 'Downloaded backup', 'BACKUP', req.ip, { full });
            await writeWorkbookTo(res, `backup-${todayStr()}.xlsx`, sheets);
        } catch (err) {
            console.error('Backup error:', err);
            if (!res.headersSent) res.status(err.code === 'MISSING_PACKAGE' ? 501 : 500).json({ error: err.message });
            else res.end();
        }
    });
    return {};
};

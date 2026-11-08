// PROPERTIES PAGE: every property with its units, tenants and service-charge status
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_MANAGE, allowRoles, app, authenticateToken, createAuditLog, guard, pool, readUnitOwnerFields, scopeSql, wrapAsync } = ctx;


    // ============================================================
    // PROPERTIES PAGE: every property with its units, tenants and service-charge status
    // ============================================================
    function serviceStatusOf(u) {
        if (u.status !== 'OCCUPIED') return 'VACANT';
        if (u.service_inclusive) return 'INCLUSIVE';
        if (!(parseFloat(u.service_charge) > 0)) return 'NONE';
        if (u.service_amount === null || u.service_amount === undefined) return 'NOT_BILLED';
        const bal = parseFloat(u.service_balance), amt = parseFloat(u.service_amount);
        if (bal <= 0) return 'PAID';
        return bal < amt ? 'PARTIAL' : 'UNPAID';
    }

    const UNITS_WITH_TENANT_SQL = `
        SELECT u.unit_id, u.property_id, u.unit_number, u.rent_amount, u.currency, u.status, u.is_furnished,
               COALESCE(u.service_charge, 0) AS service_charge, COALESCE(u.service_inclusive, false) AS service_inclusive,
               u.owner_id, ow.full_name AS owner_name, COALESCE(u.occupancy_type, 'LET') AS occupancy_type, u.service_currency,
               l.lease_id, l.end_date, l.rent_period, t.tenant_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
               sv.invoice_id AS service_invoice_id, sv.amount AS service_amount, sv.balance AS service_balance
        FROM units u
        LEFT JOIN owners ow ON ow.owner_id = u.owner_id
        LEFT JOIN leases l ON l.unit_id = u.unit_id AND l.lease_state = 'CURRENT'
        LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
        LEFT JOIN LATERAL (
            SELECT inv.invoice_id, inv.amount_due AS amount,
                   inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments py WHERE py.invoice_id = inv.invoice_id), 0) AS balance
            FROM invoices inv
            WHERE inv.lease_id = l.lease_id AND inv.invoice_type = 'SERVICE' AND inv.period_start = date_trunc('month', CURRENT_DATE)::date
            ORDER BY inv.invoice_id DESC LIMIT 1
        ) sv ON true
        WHERE u.company_id = $1`;

    app.get('/api/properties/overview', authenticateToken, wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        const pp = [cId], pu = [cId];
        const props = (await pool.query(
            `SELECT property_id, COALESCE(property_name, title) AS property_name, address, category, total_units,
                    COALESCE(service_charge_label, 'Service charge') AS service_charge_label, created_at
             FROM properties WHERE company_id = $1 ${scopeSql(req, 'property_id', pp)} ORDER BY created_at DESC, property_id DESC`, pp
        )).rows;
        const units = (await pool.query(`${UNITS_WITH_TENANT_SQL} ${scopeSql(req, 'u.property_id', pu)} ORDER BY u.property_id, u.unit_id`, pu)).rows;

        const byProp = {};
        units.forEach(u => {
            u.service_status = serviceStatusOf(u);
            (byProp[u.property_id] = byProp[u.property_id] || []).push(u);
        });
        res.json(props.map(p => {
            const list = byProp[p.property_id] || [];
            const occupied = list.filter(u => u.status === 'OCCUPIED').length;
            return {
                ...p, units: list, units_count: list.length, occupied, vacant: list.filter(u => u.status === 'VACANT').length,
                service_unpaid: list.filter(u => ['UNPAID', 'PARTIAL', 'NOT_BILLED'].includes(u.service_status)).length
            };
        }));
    }));

    app.put('/api/properties/:id', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'property', req.params.id))) return;
        const { property_name, address, category, service_charge_label } = req.body;
        if (!property_name || !address) return res.status(400).json({ error: 'Property name and address are required.' });
        const r = await pool.query(
            `UPDATE properties SET property_name = $1, title = $1, address = $2, category = COALESCE($3, category),
                    service_charge_label = COALESCE($4, service_charge_label)
             WHERE property_id = $5 AND company_id = $6 RETURNING property_id`,
            [String(property_name).trim(), String(address).trim(), category || null, service_charge_label ? String(service_charge_label).slice(0, 60) : null, req.params.id, req.user.company_id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Property', 'PROPERTIES', req.ip, { property_id: req.params.id });
        res.json({ message: 'Property updated.' });
    }));

    app.post('/api/properties/:id/units', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'property', req.params.id))) return;
        const { unit_number, rent_amount, service_charge, service_inclusive } = req.body;
        const count = Math.min(100, Math.max(1, parseInt(req.body.count) || 1));
        const rent = parseFloat(rent_amount);
        if (!unit_number || !(rent >= 0)) return res.status(400).json({ error: 'Unit name and rent amount are required.' });
        const prop = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
        if (prop.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
        const svc = Math.max(0, parseFloat(service_charge) || 0);
        const base = String(unit_number).trim();
        const of = await readUnitOwnerFields(req.user.company_id, req.body);
        try {
            for (let i = 1; i <= count; i++) {
                await pool.query(
                    `INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished, service_charge, service_inclusive, owner_id, occupancy_type, service_currency)
                     VALUES ($1, $2, $3, $4, 'TSH', 'VACANT', false, $5, $6, $7, $8, $9)`,
                    [req.user.company_id, req.params.id, count > 1 ? `${base}-${i}` : base, rent, svc, !!service_inclusive, of.owner_id || null, of.occupancy_type || 'LET', of.service_currency || null]
                );
            }
        } catch (err) {
            if (err.code === '23505') return res.status(400).json({ error: 'A unit with this name already exists in this property.' });
            throw err;
        }
        await pool.query('UPDATE properties SET total_units = (SELECT COUNT(*) FROM units WHERE property_id = $1) WHERE property_id = $1', [req.params.id]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Added Units', 'UNITS', req.ip, { property_id: req.params.id, base, count });
        res.status(201).json({ message: count > 1 ? `${count} units added.` : 'Unit added.' });
    }));

    app.put('/api/units/:id', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'unit', req.params.id))) return;
        const { unit_number, rent_amount, service_charge, service_inclusive, status } = req.body;
        const rent = parseFloat(rent_amount);
        if (!unit_number || !(rent >= 0)) return res.status(400).json({ error: 'Unit name and rent amount are required.' });
        const unit = (await pool.query('SELECT status FROM units WHERE unit_id = $1 AND company_id = $2', [req.params.id, req.user.company_id])).rows[0];
        if (!unit) return res.status(404).json({ error: 'Unit not found.' });
        let newStatus = unit.status;
        if (unit.status !== 'OCCUPIED' && ['VACANT', 'UNDER_MAINTENANCE'].includes(status)) newStatus = status;
        const of = await readUnitOwnerFields(req.user.company_id, req.body);
        try {
            await pool.query(
                `UPDATE units SET unit_number = $1, rent_amount = $2, service_charge = $3, service_inclusive = $4, status = $5,
                        owner_id = CASE WHEN $8::boolean THEN $9 ELSE owner_id END,
                        occupancy_type = COALESCE($10, occupancy_type),
                        service_currency = CASE WHEN $11::boolean THEN $12 ELSE service_currency END
                 WHERE unit_id = $6 AND company_id = $7`,
                [String(unit_number).trim(), rent, Math.max(0, parseFloat(service_charge) || 0), !!service_inclusive, newStatus, req.params.id, req.user.company_id,
                 of.owner_id !== undefined, of.owner_id === undefined ? null : of.owner_id, of.occupancy_type || null, of.service_currency !== undefined, of.service_currency === undefined ? null : of.service_currency]
            );
        } catch (err) {
            if (err.code === '23505') return res.status(400).json({ error: 'A unit with this name already exists in this property.' });
            throw err;
        }
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Unit', 'UNITS', req.ip, { unit_id: req.params.id });
        res.json({ message: 'Unit updated. New rent applies to new tenants; existing contracts keep their agreed price.' });
    }));

    // change rent / service charge of many units at once
    app.put('/api/properties/:id/bulk-units', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'property', req.params.id))) return;
        const { rent_amount, service_charge, service_inclusive, scope } = req.body;
        const sets = [], vals = [];
        if (rent_amount !== undefined && rent_amount !== '' && rent_amount !== null) {
            if (!(parseFloat(rent_amount) >= 0)) return res.status(400).json({ error: 'Invalid rent amount.' });
            vals.push(parseFloat(rent_amount)); sets.push(`rent_amount = $${vals.length}`);
        }
        if (service_charge !== undefined && service_charge !== '' && service_charge !== null) {
            if (!(parseFloat(service_charge) >= 0)) return res.status(400).json({ error: 'Invalid service charge.' });
            vals.push(parseFloat(service_charge)); sets.push(`service_charge = $${vals.length}`);
        }
        if (typeof service_inclusive === 'boolean') { vals.push(service_inclusive); sets.push(`service_inclusive = $${vals.length}`); }
        const of = await readUnitOwnerFields(req.user.company_id, req.body);
        if (of.owner_id !== undefined) { vals.push(of.owner_id); sets.push(`owner_id = $${vals.length}`); }
        if (of.occupancy_type !== undefined) { vals.push(of.occupancy_type); sets.push(`occupancy_type = $${vals.length}`); }
        if (of.service_currency !== undefined) { vals.push(of.service_currency); sets.push(`service_currency = $${vals.length}`); }
        if (sets.length === 0) return res.status(400).json({ error: 'Nothing to change.' });
        vals.push(req.params.id, req.user.company_id);
        const r = await pool.query(
            `UPDATE units SET ${sets.join(', ')} WHERE property_id = $${vals.length - 1} AND company_id = $${vals.length}
             ${scope === 'VACANT' ? "AND status = 'VACANT'" : ''} RETURNING unit_id`, vals
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Bulk edited units', 'UNITS', req.ip, { property_id: req.params.id, count: r.rows.length });
        res.json({ message: `${r.rows.length} unit(s) updated.`, updated: r.rows.length });
    }));
    return {};
};

// OWNERS of units (developers sell units; buyers stay owners and keep paying service charge) - Pro
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { ALL_ROLES, R_MANAGE, R_MONEY, R_TICKETS, R_VIEW_MONEY, allowRoles, app, authenticateToken, bcrypt, canManageTeam, checkLimit, clearUserCache, createAuditLog, inScope, isAdminUser, pool, readAccessBody, requireFeature, saveUserProjects, scopeSql, scoped, teamBelow, wrapAsync } = ctx;



    // ============================================================
    // OWNERS of units (developers sell units; buyers stay owners and keep paying service charge) - Pro
    // ============================================================
    function readOwner(b) {
        const full_name = String(b.full_name || '').trim().slice(0, 120);
        if (!full_name) return { error: 'Please write the owner name.' };
        return { v: { full_name, phone_number: String(b.phone_number || '').trim().slice(0, 30) || null, email: String(b.email || '').trim().slice(0, 120) || null, notes: String(b.notes || '').trim().slice(0, 500) || null } };
    }
    app.get('/api/owners', authenticateToken, requireFeature('org'), allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const params = [req.user.company_id];
        let having = '';
        if (scoped(req)) { params.push(req.user.scope.length ? req.user.scope : [0]); having = 'HAVING COUNT(u.unit_id) FILTER (WHERE u.property_id = ANY($2::int[])) > 0'; }
        const r = await pool.query(
            `SELECT o.owner_id, o.full_name, o.phone_number, o.email, o.notes, COUNT(u.unit_id)::int AS units
             FROM owners o LEFT JOIN units u ON u.owner_id = o.owner_id
             WHERE o.company_id = $1 GROUP BY o.owner_id ${having} ORDER BY o.full_name`, params);
        res.json(r.rows);
    }));
    app.post('/api/owners', authenticateToken, requireFeature('org'), allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        const o = readOwner(req.body); if (o.error) return res.status(400).json({ error: o.error });
        const r = await pool.query('INSERT INTO owners (company_id, full_name, phone_number, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING owner_id', [req.user.company_id, o.v.full_name, o.v.phone_number, o.v.email, o.v.notes]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Added owner', 'UNITS', req.ip, { name: o.v.full_name });
        res.status(201).json({ message: 'Owner added.', owner_id: r.rows[0].owner_id });
    }));
    // a person limited to some projects may only change owners that have a unit in those projects
    async function ownerInReach(req, res) {
        const id = parseInt(req.params.id);
        if (!(id > 0)) { res.status(404).json({ error: 'Owner not found.' }); return false; }
        if (!scoped(req)) return true;
        const r = await pool.query('SELECT 1 FROM units WHERE owner_id = $1 AND company_id = $2 AND property_id = ANY($3::int[]) LIMIT 1', [id, req.user.company_id, req.user.scope.length ? req.user.scope : [0]]);
        if (!r.rows.length) { res.status(404).json({ error: 'Owner not found.' }); return false; }
        return true;
    }
    app.put('/api/owners/:id', authenticateToken, requireFeature('org'), allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        if (!(await ownerInReach(req, res))) return;
        const o = readOwner(req.body); if (o.error) return res.status(400).json({ error: o.error });
        const r = await pool.query('UPDATE owners SET full_name = $1, phone_number = $2, email = $3, notes = $4 WHERE owner_id = $5 AND company_id = $6 RETURNING owner_id', [o.v.full_name, o.v.phone_number, o.v.email, o.v.notes, req.params.id, req.user.company_id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Owner not found.' });
        res.json({ message: 'Owner saved.' });
    }));
    app.delete('/api/owners/:id', authenticateToken, requireFeature('org'), allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        if (!(await ownerInReach(req, res))) return;
        const used = (await pool.query('SELECT COUNT(*) AS c FROM units WHERE owner_id = $1 AND company_id = $2', [req.params.id, req.user.company_id])).rows[0].c;
        if (parseInt(used) > 0) return res.status(400).json({ error: 'This owner still has units. Give those units to another owner first.' });
        const r = await pool.query('DELETE FROM owners WHERE owner_id = $1 AND company_id = $2 RETURNING owner_id', [req.params.id, req.user.company_id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Owner not found.' });
        res.json({ message: 'Owner removed.' });
    }));

    // ---- owners who live in their unit: monthly service charge (a debt) and their payments ----
    function monthStart(v) { const m = /^(\d{4})-(\d{2})/.exec(String(v || '')); if (!m) return null; const y = +m[1], mo = +m[2]; return (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12) ? `${y}-${String(mo).padStart(2, '0')}-01` : null; }
    // month: 'YYYY-MM' creates that month; year: 'YYYY' creates January up to this month (or all 12 in a past year)
    app.post('/api/owner-charges/generate', authenticateToken, requireFeature('org'), allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
        const now = new Date(); const curMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
        let months = [];
        if (req.body.month) { const ms = monthStart(req.body.month); if (!ms) return res.status(400).json({ error: 'Please choose a valid month.' }); months = [ms]; }
        else {
            const y = parseInt(req.body.year); if (!(y >= 2000 && y <= 2100)) return res.status(400).json({ error: 'Please choose a month or a year.' });
            for (let m = 0; m < 12; m++) if (y * 12 + m <= curMonth) months.push(`${y}-${String(m + 1).padStart(2, '0')}-01`);
        }
        const params = [req.user.company_id];
        const sc = scopeSql(req, 'u.property_id', params);
        const units = (await pool.query(
            `SELECT u.unit_id, u.owner_id, u.service_charge, CASE WHEN COALESCE(u.service_currency, u.currency, 'TZS') ILIKE 'USD' THEN 'USD' ELSE 'TZS' END AS cur
             FROM units u WHERE u.company_id = $1 AND u.occupancy_type = 'OWNER_LIVES' AND COALESCE(u.service_charge, 0) > 0 ${sc}`, params)).rows;
        let created = 0;
        for (const u of units) for (const m of months) {
            const r = await pool.query(
                'INSERT INTO owner_charges (company_id, unit_id, owner_id, period_month, amount, currency) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (unit_id, period_month) DO NOTHING',
                [req.user.company_id, u.unit_id, u.owner_id, m, u.service_charge, u.cur]);
            created += r.rowCount;
        }
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Generated owner service charges', 'UNITS', req.ip, { created });
        res.json({ message: created ? `${created} service charge(s) created.` : 'Nothing new to create. Every month is already billed.', created });
    }));

    app.post('/api/owner-charges/:id/pay', authenticateToken, requireFeature('org'), allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
        const id = parseInt(req.params.id);
        if (!(id > 0)) return res.status(404).json({ error: 'Charge not found.' });
        const amount = Math.round(parseFloat(req.body.amount) * 100) / 100;
        if (!(amount > 0)) return res.status(400).json({ error: 'Please enter the amount paid.' });
        const method = String(req.body.method || 'CASH').trim().slice(0, 40);
        const ref = String(req.body.reference_no || '').trim().slice(0, 80) || null;
        const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.paid_on || '')) ? req.body.paid_on : null;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const c = (await client.query(
                `SELECT oc.*, u.property_id FROM owner_charges oc JOIN units u ON u.unit_id = oc.unit_id WHERE oc.charge_id = $1 AND oc.company_id = $2 FOR UPDATE OF oc`, [id, req.user.company_id])).rows[0];
            if (!c || (scoped(req) && !inScope(req, c.property_id))) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Charge not found.' }); }
            const left = Math.round((parseFloat(c.amount) - parseFloat(c.paid_amount)) * 100) / 100;
            if (amount > left + 0.001) { await client.query('ROLLBACK'); return res.status(400).json({ error: `The amount is more than what is owed (${left}).` }); }
            await client.query('INSERT INTO owner_payments (company_id, charge_id, amount, paid_on, method, reference_no, created_by) VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7)',
                [req.user.company_id, id, amount, paidOn, method, ref, req.user.user_id]);
            await client.query('UPDATE owner_charges SET paid_amount = paid_amount + $1 WHERE charge_id = $2', [amount, id]);
            await client.query('COMMIT');
            await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Received owner service charge', 'UNITS', req.ip, { charge_id: id, amount });
            res.json({ message: 'Payment saved.' });
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    }));

    // Service charge by owner for a year: every unit, who owns it, and what was recorded.
    // A month counts as "recorded" when the unit had a tenant in it. Months with no tenant are not recorded (not a debt).
    app.get('/api/service-owners', authenticateToken, requireFeature('org'), allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        const year = Math.min(2100, Math.max(2000, parseInt(req.query.year) || new Date().getFullYear()));
        const params = [cId, year];
        const sc = scopeSql(req, 'u.property_id', params);
        const rows = (await pool.query(
            `SELECT u.unit_id, u.unit_number, u.property_id, COALESCE(p.property_name, p.title) AS property_name,
                    u.owner_id, ow.full_name AS owner_name, ow.phone_number AS owner_phone, COALESCE(u.occupancy_type, 'LET') AS occupancy_type,
                    COALESCE(u.service_charge, 0) AS service_charge, COALESCE(u.service_inclusive, false) AS service_inclusive,
                    CASE WHEN COALESCE(u.service_currency, u.currency, 'TZS') ILIKE 'USD' THEN 'USD' ELSE 'TZS' END AS svc_currency,
                    (SELECT t.full_name FROM leases l JOIN tenants t ON t.tenant_id = l.tenant_id WHERE l.unit_id = u.unit_id AND l.lease_state = 'CURRENT' LIMIT 1) AS tenant_name,
                    (SELECT COUNT(*) FROM generate_series(make_date($2::int, 1, 1), make_date($2::int, 12, 1), interval '1 month') m
                       WHERE m::date <= date_trunc('month', CURRENT_DATE)::date
                         AND EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.unit_id AND l.start_date <= (m + interval '1 month - 1 day')::date
                                     AND COALESCE(l.end_date, DATE '9999-12-31') >= m::date))::int AS months_let,
                    (SELECT COUNT(*) FROM generate_series(make_date($2::int, 1, 1), make_date($2::int, 12, 1), interval '1 month') m
                       WHERE m::date <= date_trunc('month', CURRENT_DATE)::date)::int AS months_total,
                    COALESCE((SELECT SUM(inv.amount_due) FROM invoices inv JOIN leases l ON l.lease_id = inv.lease_id
                              WHERE l.unit_id = u.unit_id AND inv.invoice_type = 'SERVICE' AND EXTRACT(YEAR FROM inv.period_start) = $2), 0) AS invoiced,
                    COALESCE((SELECT SUM(py.amount_paid) FROM payments py JOIN invoices inv ON inv.invoice_id = py.invoice_id JOIN leases l ON l.lease_id = inv.lease_id
                              WHERE l.unit_id = u.unit_id AND inv.invoice_type = 'SERVICE' AND EXTRACT(YEAR FROM inv.period_start) = $2), 0) AS paid,
                    (SELECT COALESCE(MAX(inv.currency), 'TZS') FROM invoices inv JOIN leases l ON l.lease_id = inv.lease_id WHERE l.unit_id = u.unit_id AND inv.invoice_type = 'SERVICE') AS invoice_currency
             FROM units u JOIN properties p ON p.property_id = u.property_id LEFT JOIN owners ow ON ow.owner_id = u.owner_id
             WHERE u.company_id = $1 ${sc} ORDER BY ow.full_name NULLS FIRST, p.property_id, u.unit_number`, params)).rows;

        const chargesByUnit = new Map();
        const chRows = (await pool.query(
            `SELECT charge_id, unit_id, TO_CHAR(period_month, 'YYYY-MM') AS period, amount, paid_amount FROM owner_charges WHERE company_id = $1 AND EXTRACT(YEAR FROM period_month) = $2 ORDER BY period_month`, [cId, year])).rows;
        for (const c of chRows) { if (!chargesByUnit.has(c.unit_id)) chargesByUnit.set(c.unit_id, []); chargesByUnit.get(c.unit_id).push({ charge_id: c.charge_id, period: c.period, amount: parseFloat(c.amount), paid: parseFloat(c.paid_amount) }); }
        const groups = new Map();
        const add = (m, cur, k, v) => { m[cur] = m[cur] || { recorded: 0, not_recorded: 0, invoiced: 0, paid: 0, owed: 0 }; m[cur][k] += v; };
        for (const r of rows) {
            const key = r.owner_id === null ? 'COMPANY' : String(r.owner_id);
            if (!groups.has(key)) groups.set(key, { owner_id: r.owner_id, owner_name: r.owner_name, owner_phone: r.owner_phone, units: [], totals: {}, counts: { let: 0, vacant: 0, lives: 0 } });
            const g = groups.get(key);
            const svc = parseFloat(r.service_charge);
            const state = r.tenant_name ? 'TENANT' : (r.occupancy_type === 'OWNER_LIVES' ? 'OWNER_LIVES' : 'VACANT');
            const recorded = svc * r.months_let, notRec = svc * Math.max(0, r.months_total - r.months_let);
            let invoiced = parseFloat(r.invoiced), paid = parseFloat(r.paid);
            let charges = null, invCur = r.invoice_currency || r.svc_currency;
            if (state === 'OWNER_LIVES') {
                charges = chargesByUnit.get(r.unit_id) || [];
                invoiced = charges.reduce((x, c) => x + c.amount, 0); paid = charges.reduce((x, c) => x + c.paid, 0); invCur = r.svc_currency;
            }
            g.units.push({ unit_id: r.unit_id, unit_number: r.unit_number, property_id: r.property_id, property_name: r.property_name, service_charge: svc, currency: r.svc_currency, inclusive: r.service_inclusive,
                state, tenant_name: r.tenant_name, months_let: r.months_let, months_total: r.months_total, recorded, not_recorded: notRec, invoiced, paid, owed: Math.max(0, invoiced - paid), invoice_currency: invCur, charges });
            g.counts[state === 'TENANT' ? 'let' : state === 'VACANT' ? 'vacant' : 'lives']++;
            if (state === 'OWNER_LIVES') { add(g.totals, r.svc_currency, 'recorded', svc * r.months_total); }
            else add(g.totals, r.svc_currency, 'recorded', recorded);
            if (state !== 'OWNER_LIVES') add(g.totals, r.svc_currency, 'not_recorded', notRec);
            const ic = invCur;
            add(g.totals, ic, 'invoiced', invoiced); add(g.totals, ic, 'paid', paid); add(g.totals, ic, 'owed', Math.max(0, invoiced - paid));
        }
        res.json({ year, owners: [...groups.values()] });
    }));

    app.get('/api/workers', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
        const all = req.query.all === '1';
        const r = await pool.query(
            `SELECT m.worker_id, m.full_name, m.phone_number, m.is_active,
                    (SELECT COUNT(*) FROM work_orders w WHERE w.worker_id = m.worker_id AND w.status IN ('OPEN','IN_PROGRESS'))::int AS open_jobs
             FROM maintenance_workers m WHERE m.company_id = $1 ${all ? '' : 'AND m.is_active = true'} ORDER BY m.is_active DESC, m.full_name`, [req.user.company_id]);
        res.json(r.rows);
    }));

    app.post('/api/workers', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
        const name = String(req.body.full_name || '').trim();
        if (!name) return res.status(400).json({ error: 'Please type the worker name.' });
        if (name.length > 120) return res.status(400).json({ error: 'The name is too long.' });
        const dup = await pool.query("SELECT 1 FROM maintenance_workers WHERE company_id = $1 AND LOWER(full_name) = LOWER($2) AND is_active = true", [req.user.company_id, name]);
        if (dup.rows.length) return res.status(400).json({ error: 'A worker with this name already exists.' });
        const r = await pool.query("INSERT INTO maintenance_workers (company_id, full_name, phone_number) VALUES ($1, $2, $3) RETURNING worker_id, full_name, phone_number, is_active",
            [req.user.company_id, name, String(req.body.phone_number || '').trim().slice(0, 40) || null]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Added maintenance worker', 'TICKETS', req.ip, { worker_id: r.rows[0].worker_id });
        res.status(201).json(r.rows[0]);
    }));

    app.put('/api/workers/:id', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
        const name = String(req.body.full_name || '').trim();
        if (!name) return res.status(400).json({ error: 'Please type the worker name.' });
        const r = await pool.query(
            `UPDATE maintenance_workers SET full_name = $1, phone_number = $2, is_active = $3 WHERE worker_id = $4 AND company_id = $5 RETURNING worker_id`,
            [name, String(req.body.phone_number || '').trim().slice(0, 40) || null, req.body.is_active !== false, req.params.id, req.user.company_id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Worker not found.' });
        res.json({ message: 'Worker updated.' });
    }));

    app.delete('/api/workers/:id', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
        const used = await pool.query("SELECT 1 FROM work_orders WHERE worker_id = $1 LIMIT 1", [req.params.id]);
        if (used.rows.length) {
            const r = await pool.query("UPDATE maintenance_workers SET is_active = false WHERE worker_id = $1 AND company_id = $2 RETURNING worker_id", [req.params.id, req.user.company_id]);
            if (r.rows.length === 0) return res.status(404).json({ error: 'Worker not found.' });
            return res.json({ message: 'This worker has past jobs, so he was switched off instead of deleted.', deactivated: true });
        }
        const r = await pool.query("DELETE FROM maintenance_workers WHERE worker_id = $1 AND company_id = $2 RETURNING worker_id", [req.params.id, req.user.company_id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Worker not found.' });
        res.json({ message: 'Worker removed.' });
    }));


    app.post('/api/users', authenticateToken, canManageTeam, wrapAsync(async (req, res) => {
        const { full_name, email, phone_number, password, role } = req.body;
        if (!full_name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
        if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
        if (role === 'COMPANY_ADMIN' && !isAdminUser(req)) return res.status(403).json({ error: 'Only the company administrator can add another administrator.' });
        if (!/^\S+@\S+\.\S+$/.test(String(email).trim())) return res.status(400).json({ error: 'Please enter a valid email address.' });
        const staffLimit = await checkLimit(req.user, 'max_staff', "SELECT COUNT(*) FROM users WHERE company_id = $1 AND role <> 'COMPANY_ADMIN'", 'staff members');
        if (staffLimit && role !== 'COMPANY_ADMIN') return res.status(403).json({ error: staffLimit, code: 'LIMIT_REACHED' });
        const acc = await readAccessBody(req, req.body, null);
        if (acc.error) return res.status(400).json({ error: acc.error });
        const v = acc.value;
        if (role === 'COMPANY_ADMIN') { v.scope_all = true; v.property_ids = null; }

        const cleanEmail = String(email).trim().toLowerCase();
        const exists = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [cleanEmail]);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'This email is already registered.' });
        const hashed = await bcrypt.hash(String(password), 10);
        const r = await pool.query(
            `INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants, department_id, scope_all, can_add_staff, created_by, job_title)
             VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $11, $12) RETURNING user_id`,
            [req.user.company_id, String(full_name).trim(), cleanEmail, hashed, phone_number || null, role, role === 'COMPANY_ADMIN', v.department_id, v.scope_all, v.can_add_staff && role !== 'COMPANY_ADMIN', req.user.user_id, v.job_title]
        );
        if (!v.scope_all) await saveUserProjects(r.rows[0].user_id, v.property_ids);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Added user (${role})`, 'USERS', req.ip, { email: cleanEmail });
        res.status(201).json({ message: 'User added.', user_id: r.rows[0].user_id });
    }));

    // a delegate (not the administrator) may only change people below him
    async function mayChange(req, res, targetId) {
        if (isAdminUser(req)) return true;
        const below = await teamBelow(req.user.user_id, req.user.company_id);
        if (below.map(String).includes(String(targetId))) return true;
        res.status(403).json({ error: 'You can only change the people you added.', code: 'OUT_OF_SCOPE' });
        return false;
    }

    app.put('/api/users/:id', authenticateToken, canManageTeam, wrapAsync(async (req, res) => {
        const { full_name, phone_number, role, is_active, can_edit_tenants, password } = req.body;
        const cId = req.user.company_id;
        const target = (await pool.query("SELECT user_id, role, is_active, department_id, scope_all, can_add_staff, job_title FROM users WHERE user_id = $1 AND company_id = $2 AND role <> 'SUPER_ADMIN'", [req.params.id, cId])).rows[0];
        if (!target) return res.status(404).json({ error: 'User not found.' });
        if (!(await mayChange(req, res, target.user_id))) return;
        if (!full_name) return res.status(400).json({ error: 'Name is required.' });
        if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
        if ((role === 'COMPANY_ADMIN' || target.role === 'COMPANY_ADMIN') && !isAdminUser(req)) return res.status(403).json({ error: 'Only the company administrator can do this.' });
        if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

        const isSelf = String(target.user_id) === String(req.user.user_id);
        if (isSelf && (role !== target.role || is_active === false)) return res.status(400).json({ error: 'You cannot change your own role or switch yourself off.' });

        // never leave the company without an active administrator
        if (target.role === 'COMPANY_ADMIN' && (role !== 'COMPANY_ADMIN' || is_active === false)) {
            const others = (await pool.query("SELECT COUNT(*) AS c FROM users WHERE company_id = $1 AND role = 'COMPANY_ADMIN' AND is_active = true AND user_id <> $2", [cId, target.user_id])).rows[0].c;
            if (parseInt(others) === 0) return res.status(400).json({ error: 'The company needs at least one active administrator.' });
        }

        const acc = await readAccessBody(req, req.body, target);
        if (acc.error) return res.status(400).json({ error: acc.error });
        const v = acc.value;
        if (isSelf && !isAdminUser(req) && (req.body.scope_all !== undefined || req.body.property_ids !== undefined || req.body.can_add_staff !== undefined)) {
            return res.status(400).json({ error: 'You cannot change your own access.' });
        }
        if (role === 'COMPANY_ADMIN') { v.scope_all = true; v.property_ids = null; v.can_add_staff = false; }

        const sets = ['full_name = $1', 'phone_number = $2', 'role = $3', 'is_active = $4', 'can_edit_tenants = $5', 'department_id = $6', 'scope_all = $7', 'can_add_staff = $8', 'job_title = $9'];
        const vals = [String(full_name).trim(), phone_number || null, role, is_active !== false, can_edit_tenants === true, v.department_id, v.scope_all, v.can_add_staff, v.job_title];
        if (password) { vals.push(await bcrypt.hash(String(password), 10)); sets.push(`password_hash = $${vals.length}`); }
        vals.push(target.user_id, cId);
        await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE user_id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
        if (req.body.scope_all !== undefined || req.body.property_ids !== undefined) await saveUserProjects(target.user_id, v.scope_all ? [] : v.property_ids);
        clearUserCache(target.user_id);
        await createAuditLog(pool, cId, req.user.user_id, 'Updated user', 'USERS', req.ip, { user_id: target.user_id, role });
        res.json({ message: 'User updated.' });
    }));

    app.delete('/api/users/:id', authenticateToken, canManageTeam, wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        const target = (await pool.query("SELECT user_id, role FROM users WHERE user_id = $1 AND company_id = $2 AND role <> 'SUPER_ADMIN'", [req.params.id, cId])).rows[0];
        if (!target) return res.status(404).json({ error: 'User not found.' });
        if (!(await mayChange(req, res, target.user_id))) return;
        if (String(target.user_id) === String(req.user.user_id)) return res.status(400).json({ error: 'You cannot delete your own account.' });
        if (target.role === 'COMPANY_ADMIN') {
            if (!isAdminUser(req)) return res.status(403).json({ error: 'Only the company administrator can do this.' });
            const others = (await pool.query("SELECT COUNT(*) AS c FROM users WHERE company_id = $1 AND role = 'COMPANY_ADMIN' AND is_active = true AND user_id <> $2", [cId, target.user_id])).rows[0].c;
            if (parseInt(others) === 0) return res.status(400).json({ error: 'The company needs at least one active administrator.' });
        }
        try {
            await pool.query('DELETE FROM users WHERE user_id = $1 AND company_id = $2', [target.user_id, cId]);
            await pool.query('DELETE FROM user_properties WHERE user_id = $1', [target.user_id]);
            clearUserCache(target.user_id);
            res.json({ message: 'User deleted.' });
        } catch (err) {
            if (err.code === '23503') {          // the user already has records (payments, expenses...) so keep the history
                await pool.query('UPDATE users SET is_active = false WHERE user_id = $1 AND company_id = $2', [target.user_id, cId]);
                clearUserCache(target.user_id);
                return res.json({ message: 'This user has records in the system, so the account was switched off instead of deleted.' });
            }
            throw err;
        }
    }));
    return {};
};

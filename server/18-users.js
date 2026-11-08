// who may add / change people: the company administrator, and (Pro) people he gave the right to add staff
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { ALL_ROLES, R_ADMIN, allowRoles, app, authenticateToken, canManageTeam, clearAllUserCache, createAuditLog, effectiveFeatures, getCompanyAccess, inScope, pool, requireFeature, scoped, sum, wrapAsync } = ctx;


    // ============================================================
    // USER MANAGEMENT (company owner / admin)
    // ============================================================
    // who may add / change people: the company administrator, and (Pro) people he gave the right to add staff
    // a list of ids from the database, whatever way the driver hands it over
    const idList2 = v => Array.isArray(v) ? v.map(Number) : String(v || '').replace(/[{}]/g, '').split(',').map(x => parseInt(x)).filter(x => x > 0);
    const isAdminUser = req => req.user.role === 'COMPANY_ADMIN' || req.user.role === 'SUPER_ADMIN';
    // all people below this person (the people he added, and the people they added...)
    async function teamBelow(userId, cId) {
        const r = await pool.query(
            `WITH RECURSIVE t AS (
                SELECT user_id FROM users WHERE created_by = $1 AND company_id = $2
                UNION SELECT u.user_id FROM users u JOIN t ON u.created_by = t.user_id WHERE u.company_id = $2
             ) SELECT user_id FROM t`, [userId, cId]);
        return r.rows.map(x => x.user_id);
    }
    async function orgEnabled(companyId) {
        const a = await getCompanyAccess(companyId);
        return !!effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null).org;
    }
    // reads and checks the department / projects part of a user form. Returns { error } or the values to save.
    async function readAccessBody(req, b, current) {
        const cId = req.user.company_id;
        const out = { department_id: current ? current.department_id : null, scope_all: current ? current.scope_all !== false : true, property_ids: null, can_add_staff: current ? !!current.can_add_staff : false, job_title: current ? current.job_title : null };
        if (!(await orgEnabled(cId))) return { value: out, skip: true };
        if (b.department_id !== undefined) {
            if (b.department_id === null || b.department_id === '') out.department_id = null;
            else {
                const d = await pool.query('SELECT 1 FROM departments WHERE department_id = $1 AND company_id = $2 AND is_active = true', [b.department_id, cId]);
                if (!d.rows.length) return { error: 'Department not found.' };
                out.department_id = parseInt(b.department_id);
            }
        }
        if (b.job_title !== undefined) out.job_title = String(b.job_title || '').trim().slice(0, 80) || null;
        if (b.can_add_staff !== undefined) out.can_add_staff = b.can_add_staff === true;
        if (b.scope_all !== undefined || b.property_ids !== undefined) {
            out.scope_all = b.scope_all !== false;
            if (!out.scope_all) {
                const ids = [...new Set((Array.isArray(b.property_ids) ? b.property_ids : []).map(x => parseInt(x)).filter(x => x > 0))];
                if (!ids.length) return { error: 'Choose at least one project, or choose all projects.' };
                const ok = await pool.query('SELECT property_id FROM properties WHERE company_id = $1 AND property_id = ANY($2::int[])', [cId, ids]);
                if (ok.rows.length !== ids.length) return { error: 'One of the projects was not found.' };
                out.property_ids = ids;
            }
        }
        // a person can only give access that he has himself
        if (!isAdminUser(req)) {
            if (scoped(req)) {
                if (out.scope_all) return { error: 'You can only give access to your own projects.' };
                if (out.property_ids && out.property_ids.some(id => !inScope(req, id))) return { error: 'You can only give access to your own projects.' };
            }
            if (req.user.department_id && out.department_id !== req.user.department_id && b.department_id !== undefined && out.department_id !== null) {
                return { error: 'You can add people to your own department only.' };
            }
            if (!out.department_id && req.user.department_id) out.department_id = req.user.department_id;
        }
        return { value: out };
    }
    async function saveUserProjects(userId, ids) {
        await pool.query('DELETE FROM user_properties WHERE user_id = $1', [userId]);
        if (ids && ids.length) await pool.query('INSERT INTO user_properties (user_id, property_id) SELECT $1, UNNEST($2::int[]) ON CONFLICT DO NOTHING', [userId, ids]);
    }

    app.get('/api/users', authenticateToken, canManageTeam, wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        let where = "u.company_id = $1 AND u.role <> 'SUPER_ADMIN'";
        const params = [cId];
        if (!isAdminUser(req)) {
            const below = await teamBelow(req.user.user_id, cId);
            params.push([...below, req.user.user_id]);
            where += ' AND u.user_id = ANY($2::int[])';
        }
        const r = await pool.query(
            `SELECT u.user_id, u.full_name, u.email, u.phone_number, u.role, u.is_active, COALESCE(u.can_edit_tenants, false) AS can_edit_tenants, u.created_at,
                    u.department_id, d.name AS department_name, COALESCE(u.scope_all, true) AS scope_all, COALESCE(u.can_add_staff, false) AS can_add_staff, u.job_title, u.created_by,
                    COALESCE((SELECT ARRAY_AGG(up.property_id ORDER BY up.property_id) FROM user_properties up WHERE up.user_id = u.user_id), '{}') AS property_ids
             FROM users u LEFT JOIN departments d ON d.department_id = u.department_id
             WHERE ${where} ORDER BY (u.role = 'COMPANY_ADMIN') DESC, u.full_name ASC`, params
        );
        res.json(r.rows.map(u => ({ ...u, property_ids: idList2(u.property_ids) })));
    }));

    // ---- departments (Pro) ----
    const DEPARTMENT_SUGGESTIONS = [
        { key: 'FINANCE', names: { en: 'Finance', sw: 'Fedha', zh: '财务' }, role: 'ACCOUNTANT' },
        { key: 'OPERATIONS', names: { en: 'Operations', sw: 'Operesheni', zh: '运营' }, role: 'PROPERTY_MANAGER' },
        { key: 'MAINTENANCE', names: { en: 'Maintenance', sw: 'Matengenezo', zh: '维修' }, role: 'MAINTENANCE_MANAGER' },
        { key: 'LEASING', names: { en: 'Leasing', sw: 'Upangishaji', zh: '租赁' }, role: 'PROPERTY_MANAGER' }
    ];
    app.get('/api/org/departments', authenticateToken, requireFeature('org'), canManageTeam, wrapAsync(async (req, res) => {
        const r = await pool.query(
            `SELECT d.department_id, d.name, d.default_role, d.is_active,
                    (SELECT COUNT(*) FROM users u WHERE u.department_id = d.department_id AND u.is_active = true)::int AS members
             FROM departments d WHERE d.company_id = $1 AND d.is_active = true ORDER BY d.name`, [req.user.company_id]);
        res.json({ departments: r.rows, suggestions: DEPARTMENT_SUGGESTIONS });
    }));
    function readDepartment(b) {
        const name = String(b.name || '').trim().slice(0, 80);
        if (!name) return { error: 'Please type the department name.' };
        const role = ALL_ROLES.includes(b.default_role) && b.default_role !== 'COMPANY_ADMIN' ? b.default_role : 'VIEWER';
        return { name, role };
    }
    app.post('/api/org/departments', authenticateToken, requireFeature('org'), allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
        const d = readDepartment(req.body);
        if (d.error) return res.status(400).json({ error: d.error });
        const dup = await pool.query('SELECT 1 FROM departments WHERE company_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true', [req.user.company_id, d.name]);
        if (dup.rows.length) return res.status(400).json({ error: 'This department already exists.' });
        const r = await pool.query('INSERT INTO departments (company_id, name, default_role) VALUES ($1, $2, $3) ON CONFLICT (company_id, LOWER(name)) DO UPDATE SET is_active = true, default_role = EXCLUDED.default_role RETURNING department_id', [req.user.company_id, d.name, d.role]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Added department', 'USERS', req.ip, { name: d.name });
        res.status(201).json({ message: 'Department added.', department_id: r.rows[0].department_id });
    }));
    app.put('/api/org/departments/:id', authenticateToken, requireFeature('org'), allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
        const d = readDepartment(req.body);
        if (d.error) return res.status(400).json({ error: d.error });
        const dup = await pool.query('SELECT 1 FROM departments WHERE company_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true AND department_id <> $3', [req.user.company_id, d.name, req.params.id]);
        if (dup.rows.length) return res.status(400).json({ error: 'This department already exists.' });
        const r = await pool.query('UPDATE departments SET name = $1, default_role = $2 WHERE department_id = $3 AND company_id = $4 RETURNING department_id', [d.name, d.role, req.params.id, req.user.company_id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Department not found.' });
        res.json({ message: 'Department saved.' });
    }));
    app.delete('/api/org/departments/:id', authenticateToken, requireFeature('org'), allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
        const r = await pool.query('DELETE FROM departments WHERE department_id = $1 AND company_id = $2 RETURNING department_id', [req.params.id, req.user.company_id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Department not found.' });
        await pool.query('UPDATE users SET department_id = NULL WHERE department_id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
        clearAllUserCache();
        res.json({ message: 'Department removed. Its people stay in the system without a department.' });
    }));


    // ---- the structure of the company: departments, projects, who works where, and how each is doing ----
    app.get('/api/org/structure', authenticateToken, requireFeature('org'), canManageTeam, wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        const SC = scoped(req) ? (req.user.scope.length ? req.user.scope : [0]) : null;
        const inSc = col => `AND ($2::int[] IS NULL OR ${col} = ANY($2::int[]))`;

        const projects = (await pool.query(
            `SELECT p.property_id, COALESCE(p.property_name, p.title) AS property_name, p.address, p.category,
                    (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id)::int AS units,
                    (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id AND u.status = 'OCCUPIED')::int AS occupied,
                    COALESCE(b.billed, 0) AS billed, COALESCE(b.collected, 0) AS collected,
                    COALESCE(m.collected_month, 0) AS collected_month,
                    COALESCE((SELECT SUM(e.amount) FROM expenses_tzs e WHERE e.property_id = p.property_id AND e.company_id = $1 AND e.expense_date >= date_trunc('month', CURRENT_DATE)), 0) AS expenses_month,
                    COALESCE((SELECT SUM(e.amount) FROM expenses_tzs e WHERE e.property_id = p.property_id AND e.company_id = $1), 0) AS expenses_total
             FROM properties p
             LEFT JOIN (
                 SELECT u.property_id, SUM(inv.amount_due) AS billed, SUM(LEAST(COALESCE(pay.paid, 0), inv.amount_due)) AS collected
                 FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id JOIN units u ON l.unit_id = u.unit_id
                 LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments_tzs WHERE company_id = $1 GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
                 WHERE inv.company_id = $1 GROUP BY u.property_id
             ) b ON b.property_id = p.property_id
             LEFT JOIN (
                 SELECT u.property_id, SUM(py.amount_paid) AS collected_month
                 FROM payments_tzs py JOIN invoices i ON i.invoice_id = py.invoice_id JOIN leases l ON l.lease_id = i.lease_id JOIN units u ON u.unit_id = l.unit_id
                 WHERE py.company_id = $1 AND py.payment_date >= date_trunc('month', CURRENT_DATE) GROUP BY u.property_id
             ) m ON m.property_id = p.property_id
             WHERE p.company_id = $1 ${inSc('p.property_id')} ORDER BY property_name`, [cId, SC])).rows;

        const people = (await pool.query(
            `SELECT u.user_id, u.full_name, u.email, u.role, u.is_active, u.job_title, u.department_id, COALESCE(u.scope_all, true) AS scope_all, COALESCE(u.can_add_staff, false) AS can_add_staff, u.created_by,
                    COALESCE((SELECT ARRAY_AGG(up.property_id) FROM user_properties up WHERE up.user_id = u.user_id), '{}') AS property_ids,
                    COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py WHERE py.recorded_by = u.user_id AND py.payment_date >= date_trunc('month', CURRENT_DATE)), 0) AS recorded_month,
                    (SELECT COUNT(*) FROM payments py WHERE py.recorded_by = u.user_id AND py.payment_date >= date_trunc('month', CURRENT_DATE))::int AS payments_month,
                    COALESCE((SELECT SUM(e.amount) FROM expenses_tzs e WHERE e.recorded_by = u.user_id AND e.expense_date >= date_trunc('month', CURRENT_DATE)), 0) AS expenses_month
             FROM users u WHERE u.company_id = $1 AND u.role <> 'SUPER_ADMIN' ORDER BY u.full_name`, [cId])).rows.map(u => ({ ...u, property_ids: idList2(u.property_ids) }));

        const allowedIds = SC ? new Set(SC.map(String)) : null;
        const visiblePeople = people.filter(u => {
            if (!allowedIds) return true;
            // a limited person sees the people who work on his projects
            return u.scope_all ? u.role === 'COMPANY_ADMIN' ? false : true : u.property_ids.some(id => allowedIds.has(String(id)));
        });
        const depts = (await pool.query('SELECT department_id, name, default_role FROM departments WHERE company_id = $1 AND is_active = true ORDER BY name', [cId])).rows;

        const nameOf = {}; projects.forEach(p => { nameOf[p.property_id] = p.property_name; });
        const personOut = u => ({
            user_id: u.user_id, full_name: u.full_name, role: u.role, is_active: u.is_active, job_title: u.job_title, can_add_staff: u.can_add_staff,
            all_projects: u.scope_all, projects: u.scope_all ? [] : u.property_ids.filter(id => nameOf[id]).map(id => ({ property_id: id, name: nameOf[id] }))
        });

        const projectsOut = projects.map(p => {
            const billed = parseFloat(p.billed), collected = parseFloat(p.collected);
            const occupancy = p.units > 0 ? Math.round(p.occupied / p.units * 100) : 0;
            const collection = billed > 0 ? Math.round(collected / billed * 100) : null;
            const staff = visiblePeople.filter(u => !u.scope_all && u.property_ids.map(String).includes(String(p.property_id)));
            const wide = visiblePeople.filter(u => u.scope_all && u.role !== 'COMPANY_ADMIN');
            return {
                property_id: p.property_id, property_name: p.property_name, address: p.address, category: p.category,
                units: p.units, occupied: p.occupied, vacant: p.units - p.occupied, occupancy_rate: occupancy,
                billed, collected, outstanding: Math.max(0, billed - collected), collection_rate: collection,
                collected_month: parseFloat(p.collected_month), expenses_month: parseFloat(p.expenses_month), profit_month: parseFloat(p.collected_month) - parseFloat(p.expenses_month),
                profit_total: collected - parseFloat(p.expenses_total),
                staff: staff.map(personOut), company_wide_count: wide.length
            };
        });

        const mk = (list) => ({
            members: list.map(personOut), count: list.length,
            recorded_month: list.reduce((n, u) => n + parseFloat(u.recorded_month), 0), payments_month: list.reduce((n, u) => n + u.payments_month, 0),
            expenses_month: list.reduce((n, u) => n + parseFloat(u.expenses_month), 0)
        });
        const departmentsOut = depts.map(d => ({ department_id: d.department_id, name: d.name, default_role: d.default_role, ...mk(visiblePeople.filter(u => u.department_id === d.department_id)) }));
        const noDept = visiblePeople.filter(u => !u.department_id && u.role !== 'COMPANY_ADMIN');
        const admins = people.filter(u => u.role === 'COMPANY_ADMIN');

        const sum = k => projectsOut.reduce((n, p) => n + p[k], 0);
        res.json({
            totals: { projects: projectsOut.length, units: sum('units'), occupied: sum('occupied'), collected_month: sum('collected_month'), expenses_month: sum('expenses_month'), profit_month: sum('profit_month'), outstanding: sum('outstanding'), people: visiblePeople.length },
            owner_level: SC === null,
            admins: SC === null ? admins.map(personOut) : [],
            departments: departmentsOut,
            without_department: mk(noDept),
            projects: projectsOut
        });
    }));
    return { isAdminUser, readAccessBody, saveUserProjects, teamBelow };
};

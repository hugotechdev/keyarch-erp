// MAINTENANCE TICKETS (Pro)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_MANAGE, R_TICKETS, allowRoles, app, authenticateToken, createAuditLog, guard, inScope, pool, requireFeature, scopeSql, wrapAsync } = ctx;


    // ============================================================
    // MAINTENANCE TICKETS (Pro)
    // ============================================================
    const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED'];

    app.get('/api/tickets', authenticateToken, requireFeature('tickets'), allowRoles(...R_TICKETS, 'ACCOUNTANT', 'VIEWER'), wrapAsync(async (req, res) => {
        const params = [req.user.company_id];
        let where = scopeSql(req, 'COALESCE(w.property_id, u.property_id)', params);
        const rows = (await pool.query(
            `SELECT w.ticket_id, w.title, w.description, w.priority, w.status, w.estimated_cost, w.actual_cost, w.notes, w.created_at, w.resolved_at,
                    w.unit_id, COALESCE(w.property_id, u.property_id) AS property_id, w.worker_id AS assigned_technician_id,
                    u.unit_number, COALESCE(p.property_name, p.title) AS property_name, tech.full_name AS technician_name
             FROM work_orders w
             LEFT JOIN units u ON u.unit_id = w.unit_id
             LEFT JOIN properties p ON p.property_id = COALESCE(w.property_id, u.property_id)
             LEFT JOIN maintenance_workers tech ON tech.worker_id = w.worker_id
             WHERE COALESCE(w.company_id, u.company_id) = $1 ${where}
             ORDER BY (w.status IN ('OPEN','IN_PROGRESS')) DESC,
                      CASE w.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, w.created_at DESC LIMIT 500`, params
        )).rows;
        res.json(rows);
    }));

    app.post('/api/tickets', authenticateToken, requireFeature('tickets'), allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
        const { title, description, priority, property_id, unit_id, assigned_technician_id, estimated_cost } = req.body;
        if (!String(title || '').trim()) return res.status(400).json({ error: 'Please enter a short title for the problem.' });
        if (!property_id && !unit_id) return res.status(400).json({ error: 'Choose the property (and the unit if the problem is inside one).' });
        const cId = req.user.company_id;
        let propId = property_id || null, unitId = unit_id || null;
        if (unitId) {
            const u = (await pool.query('SELECT property_id FROM units WHERE unit_id = $1 AND company_id = $2', [unitId, cId])).rows[0];
            if (!u) return res.status(404).json({ error: 'Unit not found.' });
            propId = u.property_id;
        }
        if (!inScope(req, propId)) return res.status(403).json({ error: 'You do not have access to this project.', code: 'OUT_OF_SCOPE' });
        if (!unitId) {
            const ok = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [propId, cId]);
            if (ok.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
        }
        let tech = null;
        if (assigned_technician_id) {
            const t = await pool.query("SELECT 1 FROM maintenance_workers WHERE worker_id = $1 AND company_id = $2 AND is_active = true", [assigned_technician_id, cId]);
            if (t.rows.length === 0) return res.status(400).json({ error: 'Worker not found.' });
            tech = assigned_technician_id;
        }
        const ins = await pool.query(
            `INSERT INTO work_orders (company_id, unit_id, property_id, worker_id, title, description, priority, status, estimated_cost, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9) RETURNING ticket_id`,
            [cId, unitId, propId, tech, String(title).trim(), String(description || '').trim(), TICKET_PRIORITIES.includes(priority) ? priority : 'MEDIUM',
             Math.max(0, parseFloat(estimated_cost) || 0), req.user.user_id]
        );
        await createAuditLog(pool, cId, req.user.user_id, 'Created Ticket', 'TICKETS', req.ip, { ticket_id: ins.rows[0].ticket_id });
        res.status(201).json({ message: 'Ticket created.', ticket_id: ins.rows[0].ticket_id });
    }));

    app.put('/api/tickets/:id', authenticateToken, requireFeature('tickets'), allowRoles(...R_TICKETS), async (req, res) => {
        if (!(await guard(req, res, 'ticket', req.params.id))) return;
        const cId = req.user.company_id;
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const t = (await client.query(
                `SELECT w.* , u.property_id AS unit_property_id FROM work_orders w LEFT JOIN units u ON u.unit_id = w.unit_id
                 WHERE w.ticket_id = $1 AND COALESCE(w.company_id, u.company_id) = $2 FOR UPDATE OF w`, [req.params.id, cId]
            )).rows[0];
            if (!t) throw new Error('Ticket not found.');
            const canBooks = R_MANAGE.includes(req.user.role);   // only admin / property manager can write a repair cost into Expenses

            const b = req.body;
            const status = TICKET_STATUSES.includes(b.status) ? b.status : t.status;
            const priority = TICKET_PRIORITIES.includes(b.priority) ? b.priority : t.priority;
            let tech = t.worker_id;
            if (b.assigned_technician_id !== undefined) {
                tech = b.assigned_technician_id || null;
                if (tech) {
                    const ok = await client.query("SELECT 1 FROM maintenance_workers WHERE worker_id = $1 AND company_id = $2 AND (is_active = true OR worker_id = $3)", [tech, cId, t.worker_id]);
                    if (ok.rows.length === 0) throw new Error('Worker not found.');
                }
            }
            const title = String(b.title || t.title).trim() || t.title;
            const description = b.description !== undefined ? String(b.description) : t.description;
            const estimated = b.estimated_cost !== undefined ? Math.max(0, parseFloat(b.estimated_cost) || 0) : t.estimated_cost;
            const actual = b.actual_cost !== undefined && b.actual_cost !== '' ? Math.max(0, parseFloat(b.actual_cost) || 0) : t.actual_cost;
            const notes = b.notes !== undefined ? String(b.notes) : t.notes;
            const becameResolved = status === 'RESOLVED' && t.status !== 'RESOLVED';

            await client.query(
                `UPDATE work_orders SET title = $1, description = $2, priority = $3, status = $4, worker_id = $5,
                        estimated_cost = $6, actual_cost = $7, notes = $8,
                        resolved_at = CASE WHEN $10::boolean THEN COALESCE(resolved_at, NOW()) ELSE NULL END
                 WHERE ticket_id = $9`,
                [title, description || '', priority, status, tech, estimated || 0, actual === undefined ? null : actual, notes || null, t.ticket_id, status === 'RESOLVED']
            );

            // optionally write the repair cost into Expenses (only once per ticket)
            let expenseAdded = false;
            if (becameResolved && b.add_to_expenses && canBooks && parseFloat(actual) > 0) {
                const exists = await client.query('SELECT 1 FROM expenses WHERE ticket_id = $1 AND company_id = $2', [t.ticket_id, cId]);
                if (exists.rows.length === 0) {
                    await client.query(
                        `INSERT INTO expenses (company_id, property_id, description, amount, category, recorded_by, expense_date, ticket_id)
                         VALUES ($1, $2, $3, $4, 'REPAIR', $5, CURRENT_DATE, $6)`,
                        [cId, t.property_id || t.unit_property_id || null, `Repair: ${title}`, parseFloat(actual), req.user.user_id, t.ticket_id]
                    );
                    expenseAdded = true;
                }
            }
            await createAuditLog(client, cId, req.user.user_id, 'Updated Ticket', 'TICKETS', req.ip, { ticket_id: t.ticket_id, status });
            await client.query('COMMIT');
            res.json({ message: expenseAdded ? 'Ticket updated and the cost was added to Expenses.' : 'Ticket updated.', expense_added: expenseAdded });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally { if (client) client.release(); }
    });

    app.delete('/api/tickets/:id', authenticateToken, requireFeature('tickets'), allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'ticket', req.params.id))) return;
        const r = await pool.query(
            `DELETE FROM work_orders w USING (SELECT ticket_id FROM work_orders w2 LEFT JOIN units u ON u.unit_id = w2.unit_id WHERE w2.ticket_id = $1 AND COALESCE(w2.company_id, u.company_id) = $2) x
             WHERE w.ticket_id = x.ticket_id RETURNING w.ticket_id`, [req.params.id, req.user.company_id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Ticket not found.' });
        res.json({ message: 'Ticket deleted.' });
    }));
    return {};
};

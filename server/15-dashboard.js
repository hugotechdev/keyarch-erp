// DASHBOARD OVERVIEW (one call for the whole dashboard)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { INVOICE_BALANCES_SQL, R_VIEW_MONEY, allowRoles, app, authenticateToken, loadServiceStatus, pool, scoped, sum, todayStr } = ctx;


    // ============================================================
    // DASHBOARD OVERVIEW (one call for the whole dashboard)
    // Tickets and expenses use safe queries: if a column name is
    // different in your database they return null instead of crashing.
    // ============================================================
    async function safeRows(sql, params) {
        try { return (await pool.query(sql, params)).rows; }
        catch (err) { console.error('Overview warning:', err.message); return null; }
    }

    app.get('/api/dashboard/overview', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        const cId = req.user.company_id;
        const SC = scoped(req) ? (req.user.scope.length ? req.user.scope : [0]) : null;   // project access (null = all)
        const inSc = col => `AND ($2::int[] IS NULL OR ${col} = ANY($2::int[]))`;
        try {
            const counts = (await pool.query(
                `SELECT
                    (SELECT COUNT(*) FROM properties WHERE company_id = $1 ${inSc('property_id')}) AS properties,
                    (SELECT COUNT(*) FROM units WHERE company_id = $1 ${inSc('property_id')}) AS units,
                    (SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'OCCUPIED' ${inSc('property_id')}) AS occupied,
                    (SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE company_id = $1 AND lease_state = 'CURRENT' ${inSc('property_id')}) AS tenants`,
                [cId, SC]
            )).rows[0];

            const unitsTotal = parseInt(counts.units);
            const unitsOccupied = parseInt(counts.occupied);

            // everything that is still owed, by invoice
            const owed = (await pool.query(
                `${INVOICE_BALANCES_SQL} ${inSc('p.property_id')} AND inv.amount_due - COALESCE(pay.paid, 0) > 0 ORDER BY inv.due_date ASC`,
                [cId, SC]
            )).rows.filter(r => r.currency === 'TZS');

            const bucket = (rows) => ({
                count: rows.length,
                amount: rows.reduce((sum, r) => sum + parseFloat(r.balance), 0),
                items: rows.slice(0, 50)
            });
            const due = {
                overdue: bucket(owed.filter(r => r.days_left < 0)),
                week: bucket(owed.filter(r => r.days_left >= 0 && r.days_left <= 7)),
                month: bucket(owed.filter(r => r.days_left > 7 && r.days_left <= 30))
            };
            const outstanding = owed.reduce((sum, r) => sum + parseFloat(r.balance), 0);

            // top balances per tenant
            const byTenant = {};
            owed.forEach(r => {
                const key = `${r.lease_id}`;
                if (!byTenant[key]) byTenant[key] = { tenant_name: r.tenant_name, property_name: r.property_name, unit_number: r.unit_number, balance: 0 };
                byTenant[key].balance += parseFloat(r.balance);
            });
            const debtors = Object.values(byTenant).sort((a, b) => b.balance - a.balance).slice(0, 5);

            const collectedRow = (await pool.query(
                `SELECT COALESCE(SUM(py.amount_paid), 0) AS total FROM payments_tzs py
                   JOIN invoices i ON i.invoice_id = py.invoice_id JOIN leases l ON l.lease_id = i.lease_id JOIN units u ON u.unit_id = l.unit_id
                  WHERE py.company_id = $1 AND py.payment_date >= date_trunc('month', CURRENT_DATE) ${inSc('u.property_id')}`,
                [cId, SC]
            )).rows[0];
            const collectedThisMonth = parseFloat(collectedRow.total);

            const leaseRow = (await pool.query(
                `SELECT
                    COUNT(*) FILTER (WHERE end_date < CURRENT_DATE) AS expired,
                    COUNT(*) FILTER (WHERE end_date >= CURRENT_DATE AND end_date <= CURRENT_DATE + 7) AS week,
                    COUNT(*) FILTER (WHERE end_date > CURRENT_DATE + 7 AND end_date <= CURRENT_DATE + 30) AS month
                 FROM leases WHERE company_id = $1 AND lease_state = 'CURRENT' ${inSc('property_id')}`,
                [cId, SC]
            )).rows[0];

            // property performance = half occupancy + half collection rate
            const perfRows = (await pool.query(
                `SELECT p.property_id, COALESCE(p.property_name, p.title) AS property_name,
                        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id) AS units,
                        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id AND u.status = 'OCCUPIED') AS occupied,
                        COALESCE(b.billed, 0) AS billed, COALESCE(b.collected, 0) AS collected
                 FROM properties p
                 LEFT JOIN (
                     SELECT u.property_id,
                            SUM(inv.amount_due) AS billed,
                            SUM(LEAST(COALESCE(pay.paid, 0), inv.amount_due)) AS collected
                     FROM invoices_tzs inv
                     JOIN leases l ON inv.lease_id = l.lease_id
                     JOIN units u ON l.unit_id = u.unit_id
                     LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments_tzs WHERE company_id = $1 GROUP BY invoice_id) pay
                            ON pay.invoice_id = inv.invoice_id
                     WHERE inv.company_id = $1
                     GROUP BY u.property_id
                 ) b ON b.property_id = p.property_id
                 WHERE p.company_id = $1 ${inSc('p.property_id')}`,
                [cId, SC]
            )).rows;

            const properties = perfRows.map(r => {
                const units = parseInt(r.units), occupied = parseInt(r.occupied);
                const billed = parseFloat(r.billed), collected = parseFloat(r.collected);
                const occupancy = units > 0 ? Math.round((occupied / units) * 100) : 0;
                const collection = billed > 0 ? Math.round((collected / billed) * 100) : null;
                const score = collection === null ? occupancy : (occupancy + collection) / 2;
                return {
                    property_id: r.property_id, property_name: r.property_name,
                    units, occupied, occupancy_rate: occupancy,
                    billed, collected, collection_rate: collection, score
                };
            }).sort((a, b) => b.score - a.score);

            // optional parts (names of columns in your tables may differ, so they fail safely)
            const workloadRows = await safeRows(
                `SELECT tech.worker_id AS user_id, tech.full_name, COUNT(*) AS n, MAX(CURRENT_DATE - w.created_at::date) AS oldest
                 FROM work_orders w JOIN maintenance_workers tech ON tech.worker_id = w.worker_id
                 WHERE tech.company_id = $1 AND w.status IN ('OPEN','IN_PROGRESS') ${inSc('w.property_id')}
                 GROUP BY tech.worker_id, tech.full_name ORDER BY n DESC`, [cId, SC]
            );
            const ticketRows = await safeRows(
                `SELECT COUNT(*) AS c FROM work_orders w LEFT JOIN units u ON w.unit_id = u.unit_id WHERE COALESCE(w.company_id, u.company_id) = $1 AND w.status IN ('OPEN','IN_PROGRESS') ${inSc('COALESCE(w.property_id, u.property_id)')}`,
                [cId, SC]
            );
            const expenseRows = await safeRows(
                `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses_tzs WHERE company_id = $1 AND expense_date >= date_trunc('month', CURRENT_DATE) ${inSc('property_id')}`,
                [cId, SC]
            );
            const expensesThisMonth = expenseRows ? parseFloat(expenseRows[0].total) : null;

            // vacant units, contracts ending soon (with names), service charges and a 6-month picture
            const vacantList = (await pool.query(
                `SELECT u.unit_id, u.unit_number, u.rent_amount, COALESCE(p.property_name, p.title) AS property_name
                 FROM units u JOIN properties p ON p.property_id = u.property_id
                 WHERE u.company_id = $1 AND u.status = 'VACANT' ${inSc('u.property_id')} ORDER BY p.property_id, u.unit_number LIMIT 30`, [cId, SC]
            )).rows;
            const expiring = (await pool.query(
                `SELECT l.lease_id, l.end_date, (l.end_date::date - CURRENT_DATE) AS days_left, t.tenant_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
                        u.unit_number, COALESCE(p.property_name, p.title) AS property_name
                 FROM leases l JOIN tenants t ON t.tenant_id = l.tenant_id JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
                 WHERE l.company_id = $1 AND l.lease_state = 'CURRENT' AND l.end_date <= CURRENT_DATE + 30 ${inSc('u.property_id')}
                 ORDER BY l.end_date ASC LIMIT 30`, [cId, SC]
            )).rows;
            let service = null;
            try { service = (await loadServiceStatus(cId, todayStr().slice(0, 7), null, req)).summary; } catch (e) { console.error('Overview service warning:', e.message); }

            const paySeries = (await pool.query(
                `SELECT to_char(m.month, 'YYYY-MM') AS ym,
                        COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py JOIN invoices i ON i.invoice_id = py.invoice_id JOIN leases l ON l.lease_id = i.lease_id JOIN units u ON u.unit_id = l.unit_id
                                  WHERE py.company_id = $1 AND date_trunc('month', py.payment_date) = m.month ${inSc('u.property_id')}), 0) AS collected
                 FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') AS m(month)
                 ORDER BY m.month`, [cId, SC]
            )).rows;
            const expSeries = await safeRows(
                `SELECT to_char(m.month, 'YYYY-MM') AS ym,
                        COALESCE((SELECT SUM(amount) FROM expenses_tzs WHERE company_id = $1 AND date_trunc('month', expense_date) = m.month ${inSc('property_id')}), 0) AS expenses
                 FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') AS m(month)
                 ORDER BY m.month`, [cId, SC]
            );
            const monthly = paySeries.map((r, i) => ({
                month: r.ym, collected: parseFloat(r.collected), expenses: expSeries && expSeries[i] ? parseFloat(expSeries[i].expenses) : 0
            }));

            res.json({
                vacantList, expiring, service, monthly,
                totals: {
                    properties: parseInt(counts.properties),
                    units: unitsTotal,
                    occupied: unitsOccupied,
                    vacant: unitsTotal - unitsOccupied,
                    tenants: parseInt(counts.tenants),
                    occupancyRate: unitsTotal > 0 ? Math.round((unitsOccupied / unitsTotal) * 100) : 0
                },
                money: {
                    collectedThisMonth,
                    outstanding,
                    expensesThisMonth,
                    profit: expensesThisMonth === null ? null : collectedThisMonth - expensesThisMonth
                },
                due,
                leases: { expired: parseInt(leaseRow.expired), week: parseInt(leaseRow.week), month: parseInt(leaseRow.month) },
                properties,
                debtors,
                tickets: { pending: ticketRows ? parseInt(ticketRows[0].c) : null, workload: (workloadRows || []).map(r => ({ technician_id: r.user_id, technician: r.full_name, unfinished: parseInt(r.n), oldest_days: parseInt(r.oldest) || 0 })) }
            });
        } catch (err) {
            console.error('Overview Error:', err);
            res.status(500).json({ error: err.message });
        }
    });
    return {};
};

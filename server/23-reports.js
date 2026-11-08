// REPORTS (filters: type, from - to, property) -> screen, Excel, PDF
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_VIEW_MONEY, SUPPORT, allowRoles, app, authenticateToken, effectiveFeatures, fmtMoney, getCompanyAccess, inScope, isDateStr, loadOptional, monthLabel, niceDate, pool, scoped, sum, todayStr, wrapAsync } = ctx;


    // ============================================================
    // REPORTS (filters: type, from - to, property) -> screen, Excel, PDF
    // ============================================================
    function qb(cId) { const params = [cId]; return { params, p: (v) => { params.push(v); return '$' + params.length; } }; }

    function monthsBetween(from, to) {
        const out = [];
        let y = parseInt(from.slice(0, 4)), m = parseInt(from.slice(5, 7));
        const ey = parseInt(to.slice(0, 4)), em = parseInt(to.slice(5, 7));
        while ((y < ey || (y === ey && m <= em)) && out.length < 60) {
            out.push(`${y}-${String(m).padStart(2, '0')}`);
            m++; if (m > 12) { m = 1; y++; }
        }
        return out;
    }

    async function trySql(sql, params) {
        try { return (await pool.query(sql, params)).rows; }
        catch (err) { console.error('Report warning:', err.message); return []; }
    }

    const OPEN_INVOICES_SQL = (q, extra = '') => `
        SELECT t.full_name AS tenant, t.phone_number AS phone, COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
               inv.invoice_number AS invoice, inv.invoice_type AS type, to_char(inv.due_date, 'YYYY-MM-DD') AS due_date,
               (CURRENT_DATE - inv.due_date::date) AS days_late, inv.amount_due AS total, COALESCE(pay.paid, 0) AS paid,
               inv.amount_due - COALESCE(pay.paid, 0) AS balance
        FROM invoices_tzs inv
        JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id
        JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
        LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
        WHERE inv.company_id = $1 AND inv.amount_due - COALESCE(pay.paid, 0) > 0 ${extra}`;

    const REPORTS = {
        summary: {
            label: 'Financial summary', description: 'Billed, collected, expenses and profit month by month', pro: null,
            async run(c) {
                const months = monthsBetween(c.from, c.to);
                const q1 = qb(c.cId), a1 = q1.p(c.from), b1 = q1.p(c.to), pr1 = c.propertyId ? q1.p(c.propertyId) : null;
                const billed = await trySql(
                    `SELECT to_char(date_trunc('month', COALESCE(inv.issue_date, inv.created_at::date)), 'YYYY-MM') AS ym, SUM(inv.amount_due) AS v
                     FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id JOIN units u ON l.unit_id = u.unit_id
                     WHERE inv.company_id = $1 AND COALESCE(inv.issue_date, inv.created_at::date) BETWEEN ${a1} AND ${b1} ${pr1 ? `AND u.property_id = ${pr1}` : ''} GROUP BY 1`, q1.params);
                const q2 = qb(c.cId), a2 = q2.p(c.from), b2 = q2.p(c.to), pr2 = c.propertyId ? q2.p(c.propertyId) : null;
                const collected = await trySql(
                    `SELECT to_char(date_trunc('month', py.payment_date), 'YYYY-MM') AS ym, SUM(py.amount_paid) AS v
                     FROM payments_tzs py JOIN invoices_tzs inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id JOIN units u ON l.unit_id = u.unit_id
                     WHERE py.company_id = $1 AND py.payment_date::date BETWEEN ${a2} AND ${b2} ${pr2 ? `AND u.property_id = ${pr2}` : ''} GROUP BY 1`, q2.params);
                const q3 = qb(c.cId), a3 = q3.p(c.from), b3 = q3.p(c.to), pr3 = c.propertyId ? q3.p(c.propertyId) : null;
                const expenses = await trySql(
                    `SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') AS ym, SUM(amount) AS v FROM expenses_tzs
                     WHERE company_id = $1 AND expense_date BETWEEN ${a3} AND ${b3} ${pr3 ? `AND property_id = ${pr3}` : ''} GROUP BY 1`, q3.params);
                const q4 = qb(c.cId);
                const open = await trySql(OPEN_INVOICES_SQL(q4, c.propertyId ? `AND p.property_id = ${q4.p(c.propertyId)}` : ''), q4.params);

                const pick = (arr, ym) => { const r = arr.find(x => x.ym === ym); return r ? parseFloat(r.v) : 0; };
                const rows = months.map(ym => {
                    const b = pick(billed, ym), co = pick(collected, ym), ex = pick(expenses, ym);
                    return { month: monthLabel(ym), billed: b, collected: co, expenses: ex, net: co - ex };
                });
                const tb = sum(rows, 'billed'), tc = sum(rows, 'collected'), te = sum(rows, 'expenses');
                return {
                    columns: [
                        { key: 'month', label: 'Month', type: 'text' }, { key: 'billed', label: 'Billed (invoices)', type: 'money', total: true },
                        { key: 'collected', label: 'Collected (payments)', type: 'money', total: true }, { key: 'expenses', label: 'Expenses', type: 'money', total: true },
                        { key: 'net', label: 'Profit (collected - expenses)', type: 'money', total: true }
                    ],
                    rows,
                    summary: [
                        { label: 'Billed', value: tb, type: 'money' }, { label: 'Collected', value: tc, type: 'money' },
                        { label: 'Expenses', value: te, type: 'money' }, { label: 'Profit', value: tc - te, type: 'money' },
                        { label: 'Collection rate', value: tb > 0 ? Math.round(tc / tb * 100) : 0, type: 'pct' },
                        { label: 'Still owed today (all time)', value: sum(open, 'balance'), type: 'money' }
                    ]
                };
            }
        },

        payments: {
            label: 'Payments received', description: 'Every payment (receipt) in the period', pro: null,
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const rows = (await pool.query(
                    `SELECT to_char(py.payment_date, 'YYYY-MM-DD') AS date, py.receipt_number AS receipt, t.full_name AS tenant, COALESCE(p.property_name, p.title) AS property,
                            u.unit_number AS unit, inv.invoice_number AS invoice, inv.invoice_type AS type, COALESCE(py.method_detail, py.payment_method) AS method,
                            py.reference_no AS reference, py.amount_paid AS amount
                     FROM payments py JOIN invoices inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
                     JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                     WHERE py.company_id = $1 AND py.payment_date::date BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                     ORDER BY py.payment_date, py.payment_id`, q.params
                )).rows;
                const byMethod = {};
                rows.forEach(r => { byMethod[r.method] = (byMethod[r.method] || 0) + parseFloat(r.amount); });
                return {
                    columns: [
                        { key: 'date', label: 'Date', type: 'date' }, { key: 'receipt', label: 'Receipt', type: 'text' }, { key: 'tenant', label: 'Tenant', type: 'text' },
                        { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'invoice', label: 'Invoice', type: 'text' },
                        { key: 'type', label: 'For', type: 'text' }, { key: 'method', label: 'Method', type: 'text' }, { key: 'reference', label: 'Reference', type: 'text' },
                        { key: 'amount', label: 'Amount', type: 'money', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Payments', value: rows.length, type: 'int' }, { label: 'Total received', value: sum(rows, 'amount'), type: 'money' }]
                        .concat(Object.keys(byMethod).map(k => ({ label: k, value: byMethod[k], type: 'money' })))
                };
            }
        },

        invoices: {
            label: 'Invoices issued', description: 'Invoices created in the period with their payment status', pro: null,
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const rows = (await pool.query(
                    `SELECT to_char(COALESCE(inv.issue_date, inv.created_at::date), 'YYYY-MM-DD') AS issued, inv.invoice_number AS invoice, t.full_name AS tenant,
                            COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit, inv.invoice_type AS type, COALESCE(inv.description, '') AS description,
                            inv.amount_due AS total, COALESCE(pay.paid, 0) AS paid, inv.amount_due - COALESCE(pay.paid, 0) AS balance,
                            CASE WHEN inv.amount_due - COALESCE(pay.paid, 0) <= 0 THEN 'Paid' WHEN COALESCE(pay.paid, 0) > 0 THEN 'Partial'
                                 WHEN inv.due_date < CURRENT_DATE THEN 'Overdue' ELSE 'Unpaid' END AS status
                     FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id
                     JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                     LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
                     WHERE inv.company_id = $1 AND COALESCE(inv.issue_date, inv.created_at::date) BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                     ORDER BY COALESCE(inv.issue_date, inv.created_at::date), inv.invoice_id`, q.params
                )).rows;
                return {
                    columns: [
                        { key: 'issued', label: 'Issued', type: 'date' }, { key: 'invoice', label: 'Invoice', type: 'text' }, { key: 'tenant', label: 'Tenant', type: 'text' },
                        { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
                        { key: 'description', label: 'Description', type: 'text', wide: true }, { key: 'total', label: 'Total', type: 'money', total: true },
                        { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'balance', label: 'Balance', type: 'money', total: true }, { key: 'status', label: 'Status', type: 'text' }
                    ],
                    rows,
                    summary: [{ label: 'Invoices', value: rows.length, type: 'int' }, { label: 'Billed', value: sum(rows, 'total'), type: 'money' },
                              { label: 'Paid', value: sum(rows, 'paid'), type: 'money' }, { label: 'Balance', value: sum(rows, 'balance'), type: 'money' }]
                };
            }
        },

        outstanding: {
            label: 'Outstanding balances (debtors)', description: 'Who still owes money, invoice by invoice', pro: null,
            async run(c) {
                const q = qb(c.cId);
                let extra = '';
                if (c.propertyId) extra += ` AND p.property_id = ${q.p(c.propertyId)}`;
                if (c.dueOnly) extra += ` AND inv.due_date <= ${q.p(c.to)}`;
                const rows = (await pool.query(`${OPEN_INVOICES_SQL(q, extra)} ORDER BY inv.due_date, t.full_name`, q.params)).rows
                    .map(r => ({ ...r, days_late: Math.max(0, parseInt(r.days_late)) }));
                const tenants = new Set(rows.map(r => r.tenant + '|' + r.unit + '|' + r.property)).size;
                return {
                    columns: [
                        { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'property', label: 'Property', type: 'text' },
                        { key: 'unit', label: 'Unit', type: 'text' }, { key: 'invoice', label: 'Invoice', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
                        { key: 'due_date', label: 'Due date', type: 'date' }, { key: 'days_late', label: 'Days late', type: 'int' },
                        { key: 'total', label: 'Invoice total', type: 'money', total: true }, { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'balance', label: 'Balance', type: 'money', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Tenants owing', value: tenants, type: 'int' }, { label: 'Invoices unpaid', value: rows.length, type: 'int' }, { label: 'Total owed', value: sum(rows, 'balance'), type: 'money' }]
                };
            }
        },

        aging: {
            label: 'Debt age (how late)', description: 'Debts grouped by how many days late: 1-30, 31-60, 61-90, over 90', pro: 'reports_advanced',
            async run(c) {
                const q = qb(c.cId);
                const base = OPEN_INVOICES_SQL(q, c.propertyId ? `AND p.property_id = ${q.p(c.propertyId)}` : '');
                const rows = (await pool.query(
                    `SELECT tenant, MAX(phone) AS phone, property, unit,
                            SUM(CASE WHEN days_late <= 0 THEN balance ELSE 0 END) AS not_due,
                            SUM(CASE WHEN days_late BETWEEN 1 AND 30 THEN balance ELSE 0 END) AS d30,
                            SUM(CASE WHEN days_late BETWEEN 31 AND 60 THEN balance ELSE 0 END) AS d60,
                            SUM(CASE WHEN days_late BETWEEN 61 AND 90 THEN balance ELSE 0 END) AS d90,
                            SUM(CASE WHEN days_late > 90 THEN balance ELSE 0 END) AS d90p,
                            SUM(balance) AS total
                     FROM (${base}) x GROUP BY tenant, property, unit ORDER BY total DESC`, q.params
                )).rows;
                return {
                    columns: [
                        { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
                        { key: 'not_due', label: 'Not yet due', type: 'money', total: true }, { key: 'd30', label: '1-30 days', type: 'money', total: true },
                        { key: 'd60', label: '31-60 days', type: 'money', total: true }, { key: 'd90', label: '61-90 days', type: 'money', total: true },
                        { key: 'd90p', label: 'Over 90 days', type: 'money', total: true }, { key: 'total', label: 'Total owed', type: 'money', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Tenants owing', value: rows.length, type: 'int' }, { label: 'Total owed', value: sum(rows, 'total'), type: 'money' },
                              { label: 'Over 60 days late', value: sum(rows, 'd90') + sum(rows, 'd90p'), type: 'money' }]
                };
            }
        },

        expenses: {
            label: 'Expenses', description: 'Money spent in the period, by category', pro: null,
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const rows = (await pool.query(
                    `SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS date, e.category, e.description, COALESCE(p.property_name, p.title, 'General') AS property, COALESCE(e.payee, '') AS payee, e.amount
                     FROM expenses e LEFT JOIN properties p ON p.property_id = e.property_id
                     WHERE e.company_id = $1 AND e.expense_date BETWEEN ${a} AND ${b} ${pr ? `AND e.property_id = ${pr}` : ''} ORDER BY e.expense_date, e.expense_id`, q.params
                )).rows;
                const byCat = {};
                rows.forEach(r => { byCat[r.category] = (byCat[r.category] || 0) + parseFloat(r.amount); });
                return {
                    columns: [
                        { key: 'date', label: 'Date', type: 'date' }, { key: 'category', label: 'Category', type: 'text' }, { key: 'description', label: 'Description', type: 'text', wide: true },
                        { key: 'property', label: 'Property', type: 'text' }, { key: 'payee', label: 'Paid to', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Total expenses', value: sum(rows, 'amount'), type: 'money' }].concat(Object.keys(byCat).map(k => ({ label: k, value: byCat[k], type: 'money' })))
                };
            }
        },

        profit: {
            label: 'Profit by property', description: 'Income, expenses and profit for each property', pro: 'reports_advanced',
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const props = (await pool.query(
                    `SELECT COALESCE(p.property_name, p.title) AS property,
                            COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py JOIN invoices_tzs inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
                                      JOIN units u ON l.unit_id = u.unit_id WHERE u.property_id = p.property_id AND py.company_id = $1 AND py.payment_date::date BETWEEN ${a} AND ${b}), 0) AS income,
                            (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id) AS units,
                            (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id AND u.status = 'OCCUPIED') AS occupied,
                            p.property_id
                     FROM properties p WHERE p.company_id = $1 ${pr ? `AND p.property_id = ${pr}` : ''} ORDER BY property`, q.params
                )).rows;
                const q2 = qb(c.cId), a2 = q2.p(c.from), b2 = q2.p(c.to);
                const exp = await trySql(`SELECT property_id, SUM(amount) AS v FROM expenses_tzs WHERE company_id = $1 AND expense_date BETWEEN ${a2} AND ${b2} GROUP BY property_id`, q2.params);
                const rows = props.map(p => {
                    const e = exp.find(x => String(x.property_id) === String(p.property_id));
                    const income = parseFloat(p.income), expenses = e ? parseFloat(e.v) : 0;
                    return { property: p.property, units: parseInt(p.units), occupied: parseInt(p.occupied), income, expenses, profit: income - expenses };
                });
                if (!c.propertyId) {
                    const general = exp.find(x => x.property_id === null);
                    if (general) rows.push({ property: 'General (not linked to a property)', units: 0, occupied: 0, income: 0, expenses: parseFloat(general.v), profit: -parseFloat(general.v) });
                }
                return {
                    columns: [
                        { key: 'property', label: 'Property', type: 'text' }, { key: 'units', label: 'Units', type: 'int', total: true }, { key: 'occupied', label: 'Occupied', type: 'int', total: true },
                        { key: 'income', label: 'Income (payments)', type: 'money', total: true }, { key: 'expenses', label: 'Expenses', type: 'money', total: true }, { key: 'profit', label: 'Profit', type: 'money', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Income', value: sum(rows, 'income'), type: 'money' }, { label: 'Expenses', value: sum(rows, 'expenses'), type: 'money' }, { label: 'Profit', value: sum(rows, 'profit'), type: 'money' }]
                };
            }
        },

        property_income: {
            label: 'Property income', description: 'Money collected by each property: rent, service charge and other', pro: null,
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const rows = (await pool.query(
                    `SELECT COALESCE(p.property_name, p.title) AS property,
                            COALESCE(SUM(CASE WHEN inv.invoice_type = 'RENT' THEN py.amount_paid END), 0) AS rent,
                            COALESCE(SUM(CASE WHEN inv.invoice_type = 'SERVICE' THEN py.amount_paid END), 0) AS service,
                            COALESCE(SUM(CASE WHEN inv.invoice_type NOT IN ('RENT','SERVICE') THEN py.amount_paid END), 0) AS other,
                            COALESCE(SUM(py.amount_paid), 0) AS total, COUNT(py.payment_id) AS payments
                     FROM properties p
                     LEFT JOIN units u ON u.property_id = p.property_id
                     LEFT JOIN leases l ON l.unit_id = u.unit_id
                     LEFT JOIN invoices_tzs inv ON inv.lease_id = l.lease_id
                     LEFT JOIN payments_tzs py ON py.invoice_id = inv.invoice_id AND py.company_id = $1 AND py.payment_date::date BETWEEN ${a} AND ${b}
                     WHERE p.company_id = $1 ${pr ? `AND p.property_id = ${pr}` : ''}
                     GROUP BY p.property_id, p.property_name, p.title ORDER BY total DESC, property`, q.params
                )).rows.map(r => ({ ...r, payments: parseInt(r.payments) }));
                return {
                    columns: [
                        { key: 'property', label: 'Property', type: 'text' }, { key: 'rent', label: 'Rent', type: 'money', total: true },
                        { key: 'service', label: 'Service charge', type: 'money', total: true }, { key: 'other', label: 'Other', type: 'money', total: true },
                        { key: 'total', label: 'Total collected', type: 'money', total: true }, { key: 'payments', label: 'Payments', type: 'int', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Total collected', value: sum(rows, 'total'), type: 'money' }, { label: 'Rent', value: sum(rows, 'rent'), type: 'money' },
                              { label: 'Service charge', value: sum(rows, 'service'), type: 'money' }, { label: 'Other', value: sum(rows, 'other'), type: 'money' }]
                };
            }
        },

        maintenance: {
            label: 'Maintenance', description: 'Repair tickets of the period: status, worker and cost', pro: 'tickets',
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const raw = (await pool.query(
                    `SELECT to_char(w.created_at, 'YYYY-MM-DD') AS date, w.title, COALESCE(p.property_name, p.title, '') AS property, COALESCE(u.unit_number, '') AS unit,
                            COALESCE(tech.full_name, 'Not assigned') AS technician, w.priority, w.status,
                            COALESCE(w.estimated_cost, 0) AS estimated, COALESCE(w.actual_cost, 0) AS cost,
                            (COALESCE(w.resolved_at, NOW())::date - w.created_at::date) AS days
                     FROM work_orders w
                     LEFT JOIN units u ON u.unit_id = w.unit_id
                     LEFT JOIN properties p ON p.property_id = COALESCE(w.property_id, u.property_id)
                     LEFT JOIN maintenance_workers tech ON tech.worker_id = w.worker_id
                     WHERE COALESCE(w.company_id, u.company_id) = $1 AND w.created_at::date BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                     ORDER BY w.status, w.created_at DESC`, q.params
                )).rows;
                const label = { OPEN: 'Open', IN_PROGRESS: 'In progress', RESOLVED: 'Resolved', CANCELLED: 'Cancelled' };
                const rows = raw.map(r => ({ ...r, status: label[r.status] || r.status, days: parseInt(r.days) || 0 }));
                const cnt = s => rows.filter(r => r.status === s).length;
                const byTech = {};
                rows.filter(r => r.status === 'Open' || r.status === 'In progress').forEach(r => { byTech[r.technician] = (byTech[r.technician] || 0) + 1; });
                return {
                    columns: [
                        { key: 'date', label: 'Date', type: 'date' }, { key: 'title', label: 'Problem', type: 'text', wide: true }, { key: 'property', label: 'Property', type: 'text' },
                        { key: 'unit', label: 'Unit', type: 'text' }, { key: 'technician', label: 'Worker', type: 'text' }, { key: 'priority', label: 'Priority', type: 'text' },
                        { key: 'status', label: 'Status', type: 'text' }, { key: 'days', label: 'Days', type: 'int' }, { key: 'estimated', label: 'Estimated', type: 'money', total: true },
                        { key: 'cost', label: 'Actual cost', type: 'money', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Tickets', value: rows.length, type: 'int' }, { label: 'Open', value: cnt('Open'), type: 'int' }, { label: 'In progress', value: cnt('In progress'), type: 'int' },
                              { label: 'Resolved', value: cnt('Resolved'), type: 'int' }, { label: 'Total cost', value: sum(rows, 'cost'), type: 'money' }]
                        .concat(Object.keys(byTech).map(k => ({ label: 'Unfinished - ' + k, value: byTech[k], type: 'int' })))
                };
            }
        },

        tenants: {
            label: 'Tenants list', description: 'All tenants with their latest contract and balance', pro: null,
            async run(c) {
                const q = qb(c.cId);
                const rows = (await pool.query(
                    `SELECT * FROM (
                        SELECT DISTINCT ON (t.tenant_id) t.full_name AS tenant, t.phone_number AS phone, COALESCE(t.identity_type, '') || ' ' || COALESCE(t.nida_passport_no, '') AS id_no,
                               COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
                               CASE WHEN l.lease_state = 'CURRENT' THEN 'Active' ELSE 'Moved out' END AS status,
                               to_char(l.start_date, 'YYYY-MM-DD') AS start_date, to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
                               COALESCE(l.total_to_pay, l.agreed_rent, 0) AS contract_total,
                               (SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0)
                                  FROM invoices_tzs inv JOIN leases l2 ON inv.lease_id = l2.lease_id WHERE l2.tenant_id = t.tenant_id AND inv.company_id = $1) AS balance
                        FROM tenants t JOIN leases l ON l.tenant_id = t.tenant_id JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
                        WHERE t.company_id = $1 ${c.propertyId ? `AND p.property_id = ${q.p(c.propertyId)}` : ''}
                        ORDER BY t.tenant_id, (l.lease_state = 'CURRENT') DESC, l.lease_id DESC
                     ) x ORDER BY (status = 'Active') DESC, tenant`, q.params
                )).rows;
                return {
                    columns: [
                        { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'id_no', label: 'ID', type: 'text' },
                        { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
                        { key: 'start_date', label: 'Start', type: 'date' }, { key: 'end_date', label: 'End', type: 'date' },
                        { key: 'contract_total', label: 'Contract total', type: 'money', total: true }, { key: 'balance', label: 'Balance owed', type: 'money', total: true }
                    ],
                    rows,
                    summary: [{ label: 'Tenants', value: rows.length, type: 'int' }, { label: 'Active', value: rows.filter(r => r.status === 'Active').length, type: 'int' }, { label: 'Total owed', value: sum(rows, 'balance'), type: 'money' }]
                };
            }
        },

        occupancy: {
            label: 'Units: occupied and vacant', description: 'Every unit with its status, rent and tenant', pro: null,
            async run(c) {
                const q = qb(c.cId);
                const rows = (await pool.query(
                    `SELECT COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
                            CASE u.status WHEN 'OCCUPIED' THEN 'Occupied' WHEN 'VACANT' THEN 'Vacant' ELSE 'Under maintenance' END AS status,
                            u.rent_amount AS rent, COALESCE(u.service_charge, 0) AS service_charge, CASE WHEN COALESCE(u.service_inclusive, false) THEN 'Included in rent' ELSE '' END AS service_note,
                            COALESCE(t.full_name, '') AS tenant, COALESCE(t.phone_number, '') AS phone, COALESCE(to_char(l.end_date, 'YYYY-MM-DD'), '') AS lease_end
                     FROM units u JOIN properties p ON p.property_id = u.property_id
                     LEFT JOIN leases l ON l.unit_id = u.unit_id AND l.lease_state = 'CURRENT' LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
                     WHERE u.company_id = $1 ${c.propertyId ? `AND p.property_id = ${q.p(c.propertyId)}` : ''} ORDER BY p.property_id, u.unit_number`, q.params
                )).rows;
                const occ = rows.filter(r => r.status === 'Occupied').length;
                return {
                    columns: [
                        { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
                        { key: 'rent', label: 'Rent', type: 'money' }, { key: 'service_charge', label: 'Service charge', type: 'money' }, { key: 'service_note', label: 'Note', type: 'text' },
                        { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'lease_end', label: 'Contract ends', type: 'date' }
                    ],
                    rows,
                    summary: [{ label: 'Units', value: rows.length, type: 'int' }, { label: 'Occupied', value: occ, type: 'int' }, { label: 'Vacant', value: rows.filter(r => r.status === 'Vacant').length, type: 'int' },
                              { label: 'Occupancy', value: rows.length ? Math.round(occ / rows.length * 100) : 0, type: 'pct' }]
                };
            }
        },

        service: {
            label: 'Service charges', description: 'Service charge invoices of the period: paid and not paid', pro: 'reports_advanced',
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const rows = (await pool.query(
                    `SELECT COALESCE(to_char(inv.period_start, 'YYYY-MM'), '') AS month, COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit, t.full_name AS tenant, t.phone_number AS phone,
                            inv.invoice_number AS invoice, inv.amount_due AS total, COALESCE(pay.paid, 0) AS paid, inv.amount_due - COALESCE(pay.paid, 0) AS balance,
                            CASE WHEN inv.amount_due - COALESCE(pay.paid, 0) <= 0 THEN 'Paid' WHEN COALESCE(pay.paid, 0) > 0 THEN 'Partial' ELSE 'Not paid' END AS status
                     FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                     LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
                     WHERE inv.company_id = $1 AND inv.invoice_type = 'SERVICE' AND COALESCE(inv.period_start, inv.issue_date) BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                     ORDER BY inv.period_start, p.property_id, u.unit_number`, q.params
                )).rows;
                return {
                    columns: [
                        { key: 'month', label: 'Month', type: 'text' }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'tenant', label: 'Tenant', type: 'text' },
                        { key: 'phone', label: 'Phone', type: 'text' }, { key: 'invoice', label: 'Invoice', type: 'text' }, { key: 'total', label: 'Charge', type: 'money', total: true },
                        { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'balance', label: 'Balance', type: 'money', total: true }, { key: 'status', label: 'Status', type: 'text' }
                    ],
                    rows,
                    summary: [{ label: 'Charges', value: rows.length, type: 'int' }, { label: 'Not fully paid', value: rows.filter(r => r.status !== 'Paid').length, type: 'int' },
                              { label: 'Billed', value: sum(rows, 'total'), type: 'money' }, { label: 'Not paid yet', value: sum(rows, 'balance'), type: 'money' }]
                };
            }
        },

        expiries: {
            label: 'Contracts ending', description: 'Contracts whose end date falls in the period (use it to plan renewals)', pro: 'reports_advanced',
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
                const rows = (await pool.query(
                    `SELECT t.full_name AS tenant, t.phone_number AS phone, COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
                            to_char(l.start_date, 'YYYY-MM-DD') AS start_date, to_char(l.end_date, 'YYYY-MM-DD') AS end_date, (l.end_date::date - CURRENT_DATE) AS days_left,
                            COALESCE(l.total_to_pay, l.agreed_rent, 0) AS contract_total
                     FROM leases l JOIN tenants t ON t.tenant_id = l.tenant_id JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
                     WHERE l.company_id = $1 AND l.lease_state = 'CURRENT' AND l.end_date BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''} ORDER BY l.end_date`, q.params
                )).rows.map(r => ({ ...r, days_left: parseInt(r.days_left) }));
                return {
                    columns: [
                        { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
                        { key: 'start_date', label: 'Start', type: 'date' }, { key: 'end_date', label: 'Ends', type: 'date' }, { key: 'days_left', label: 'Days left', type: 'int' },
                        { key: 'contract_total', label: 'Contract total', type: 'money' }
                    ],
                    rows,
                    summary: [{ label: 'Contracts ending', value: rows.length, type: 'int' }]
                };
            }
        },

        luku: {
            label: 'Luku sales', description: 'Tokens sold in the period', pro: 'luku',
            async run(c) {
                const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to);
                const rows = (await pool.query(
                    `SELECT to_char(v.sold_at, 'YYYY-MM-DD') AS date, COALESCE(v.unit_name, v.meter_number) AS unit, COALESCE(v.tenant_name, '') AS customer, v.amount, v.kwh_units AS kwh, COALESCE(u.full_name, '') AS sold_by
                     FROM luku_vouchers v LEFT JOIN users u ON u.user_id = v.sold_by
                     WHERE v.company_id = $1 AND v.sold_at::date BETWEEN ${a} AND ${b} ORDER BY v.sold_at`, q.params
                )).rows;
                return {
                    columns: [
                        { key: 'date', label: 'Date', type: 'date' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'customer', label: 'Customer', type: 'text' },
                        { key: 'amount', label: 'Amount', type: 'money', total: true }, { key: 'kwh', label: 'kWh', type: 'text' }, { key: 'sold_by', label: 'Sold by', type: 'text' }
                    ],
                    rows,
                    summary: [{ label: 'Tokens sold', value: rows.length, type: 'int' }, { label: 'Total sales', value: sum(rows, 'amount'), type: 'money' }]
                };
            }
        }
    };

    function cleanReportRows(report) {
        report.rows = report.rows.map(r => {
            const o = {};
            report.columns.forEach(col => {
                let v = r[col.key];
                if (v === null || v === undefined) v = col.type === 'money' || col.type === 'int' ? 0 : '';
                if (col.type === 'money') v = Math.round((parseFloat(v) || 0) * 100) / 100;
                else if (col.type === 'int') v = parseInt(v) || 0;
                else v = String(v);
                o[col.key] = v;
            });
            return o;
        });
        return report;
    }

    async function buildReport(req) {
        const type = REPORTS[req.query.type] ? req.query.type : null;
        if (!type) { const e = new Error('Choose a report.'); e.status = 400; throw e; }
        const def = REPORTS[type];
        if (def.pro && req.user.role !== 'SUPER_ADMIN') {
            const a = await getCompanyAccess(req.user.company_id);
            if (!effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null)[def.pro]) {
                const e = new Error('This report is available on the Pro plan. Please contact ' + SUPPORT.name + ' to upgrade.'); e.status = 403; e.code = 'FEATURE_LOCKED'; throw e;
            }
        }
        let from = isDateStr(req.query.from) ? req.query.from : todayStr().slice(0, 7) + '-01';
        let to = isDateStr(req.query.to) ? req.query.to : todayStr();
        if (to < from) { const t = from; from = to; to = t; }
        const cId = req.user.company_id;
        let propertyId = null, propertyName = 'All properties';
        let wantedProp = req.query.property_id;
        if (scoped(req)) {      // a person limited to some projects gets the report of one project at a time
            if (!wantedProp && req.user.scope.length === 1) wantedProp = req.user.scope[0];
            if (!wantedProp) { const e = new Error('Please choose a project.'); e.status = 400; e.code = 'CHOOSE_PROJECT'; throw e; }
            if (!inScope(req, wantedProp)) { const e = new Error('You do not have access to this project.'); e.status = 403; e.code = 'OUT_OF_SCOPE'; throw e; }
        }
        if (wantedProp) {
            const p = (await pool.query('SELECT property_id, COALESCE(property_name, title) AS n FROM properties WHERE property_id = $1 AND company_id = $2', [wantedProp, cId])).rows[0];
            if (!p) { const e = new Error('Property not found.'); e.status = 404; throw e; }
            propertyId = p.property_id; propertyName = p.n;
        }
        const company = (await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [cId])).rows[0] || {};
        const report = cleanReportRows(await def.run({ cId, from, to, propertyId, dueOnly: req.query.due_only === '1' }));
        return {
            type, title: def.label, company_name: company.company_name || '', property: propertyName, from, to,
            period: `${niceDate(from)} to ${niceDate(to)}`, generated: new Date().toISOString(), ...report
        };
    }

    app.get('/api/reports/types', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const a = req.user.role === 'SUPER_ADMIN' ? null : await getCompanyAccess(req.user.company_id);
        const feats = req.user.role === 'SUPER_ADMIN' ? effectiveFeatures('PRO', {}) : effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null);
        res.json(Object.keys(REPORTS).map(k => ({ key: k, label: REPORTS[k].label, description: REPORTS[k].description, locked: !!(REPORTS[k].pro && !feats[REPORTS[k].pro]) })));
    }));

    app.get('/api/reports/run', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        try { res.json(await buildReport(req)); }
        catch (err) { if (!err.status) console.error('Report error:', err); res.status(err.status || 500).json({ error: err.message, code: err.code }); }
    });

    // ---- Excel ----
    function toExcelValue(v, type) {
        if (type === 'date' && isDateStr(v)) return new Date(v + 'T00:00:00Z');
        return v;
    }
    async function writeWorkbookTo(res, filename, sheets) {
        const ExcelJS = loadOptional('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.creator = 'KEY ARCH'; wb.created = new Date();
        for (const sh of sheets) {
            const ws = wb.addWorksheet(String(sh.name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
            let r = 1;
            (sh.heading || []).forEach((line, i) => {
                const row = ws.getRow(r++); row.getCell(1).value = line;
                row.getCell(1).font = i === 0 ? { bold: true, size: 14 } : (i === 1 ? { bold: true, size: 12 } : { color: { argb: 'FF555555' } });
            });
            if ((sh.summary || []).length) {
                r++;
                sh.summary.forEach(s => {
                    const row = ws.getRow(r++);
                    row.getCell(1).value = s.label; row.getCell(1).font = { bold: true };
                    row.getCell(2).value = s.value;
                    if (s.type === 'money') row.getCell(2).numFmt = '#,##0.##';
                    if (s.type === 'pct') row.getCell(2).numFmt = '0"%"';
                    row.getCell(2).alignment = { horizontal: 'left' };
                });
            }
            r++;
            const headerRow = r;
            const hr = ws.getRow(r++);
            sh.columns.forEach((c, i) => {
                const cell = hr.getCell(i + 1);
                cell.value = c.label;
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
                cell.alignment = { horizontal: c.type === 'money' || c.type === 'int' ? 'right' : 'left', vertical: 'middle' };
            });
            sh.rows.forEach(rowData => {
                const row = ws.getRow(r++);
                sh.columns.forEach((c, i) => {
                    const cell = row.getCell(i + 1);
                    cell.value = toExcelValue(rowData[c.key], c.type);
                    if (c.type === 'money') cell.numFmt = '#,##0.##';
                    else if (c.type === 'int') cell.numFmt = '#,##0';
                    else if (c.type === 'date') cell.numFmt = 'dd mmm yyyy';
                });
            });
            if (sh.columns.some(c => c.total) && sh.rows.length) {
                const tr = ws.getRow(r++);
                sh.columns.forEach((c, i) => {
                    const cell = tr.getCell(i + 1);
                    cell.font = { bold: true };
                    cell.border = { top: { style: 'thin' } };
                    if (i === 0) cell.value = 'TOTAL';
                    if (c.total) { cell.value = Math.round(sh.rows.reduce((s, x) => s + (parseFloat(x[c.key]) || 0), 0) * 100) / 100; cell.numFmt = '#,##0.##'; }
                });
            }
            sh.columns.forEach((c, i) => {
                let w = String(c.label).length + 2;
                sh.rows.slice(0, 200).forEach(x => { w = Math.max(w, String(x[c.key] === undefined ? '' : x[c.key]).length + 2); });
                ws.getColumn(i + 1).width = Math.min(Math.max(w, 10), c.wide ? 60 : 32);
            });
            ws.views = [{ state: 'frozen', ySplit: headerRow }];
            if (sh.rows.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: sh.columns.length } };
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        await wb.xlsx.write(res);
        res.end();
    }

    // ---- PDF ----
    function pdfText(v, type) {
        if (type === 'money') return fmtMoney(v);
        if (type === 'int') return String(v);
        if (type === 'date') return isDateStr(v) ? niceDate(v) : String(v || '');
        return String(v === undefined || v === null ? '' : v);
    }
    function writeReportPdf(res, filename, rep) {
        const PDFDocument = loadOptional('pdfkit');
        const cols = rep.columns;
        const landscape = cols.length > 6;
        const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 32, bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);

        const left = doc.page.margins.left;
        const usable = doc.page.width - left - doc.page.margins.right;
        const weight = c => (c.wide ? 3 : c.type === 'money' ? 1.5 : c.type === 'date' ? 1.2 : c.type === 'int' ? 0.8 : 1.6);
        const totalW = cols.reduce((s, c) => s + weight(c), 0);
        const widths = cols.map(c => usable * weight(c) / totalW);
        const rowH = 17;
        const bottom = () => doc.page.height - doc.page.margins.bottom - 24;

        doc.fillColor('#111').font('Helvetica-Bold').fontSize(15).text(rep.company_name || 'Report', left, doc.y);
        doc.font('Helvetica-Bold').fontSize(12).text(rep.title);
        doc.font('Helvetica').fontSize(9).fillColor('#555').text(`Period: ${rep.period}   |   ${rep.property}`);
        doc.moveDown(0.6);

        if (rep.summary && rep.summary.length) {
            rep.summary.forEach(s => {
                const val = s.type === 'money' ? fmtMoney(s.value) : (s.type === 'pct' ? s.value + '%' : String(s.value));
                doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(`${s.label}: `, { continued: true }).font('Helvetica').text(val);
            });
            doc.moveDown(0.6);
        }

        let y = doc.y;
        const drawHeader = () => {
            doc.save().rect(left, y, usable, rowH).fill('#1F3A5F').restore();
            let x = left;
            cols.forEach((c, i) => {
                doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8)
                   .text(c.label, x + 3, y + 5, { width: widths[i] - 6, height: rowH - 5, ellipsis: true, lineBreak: false, align: (c.type === 'money' || c.type === 'int') ? 'right' : 'left' });
                x += widths[i];
            });
            y += rowH;
        };
        drawHeader();

        const drawRow = (data, bold, shade) => {
            if (y + rowH > bottom()) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
            if (shade) doc.save().rect(left, y, usable, rowH).fill('#F1F4F8').restore();
            let x = left;
            cols.forEach((c, i) => {
                doc.fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
                   .text(data[i], x + 3, y + 5, { width: widths[i] - 6, height: rowH - 5, ellipsis: true, lineBreak: false, align: (c.type === 'money' || c.type === 'int') ? 'right' : 'left' });
                x += widths[i];
            });
            y += rowH;
        };
        rep.rows.forEach((r, idx) => drawRow(cols.map(c => pdfText(r[c.key], c.type)), false, idx % 2 === 1));
        if (cols.some(c => c.total) && rep.rows.length) {
            drawRow(cols.map((c, i) => c.total ? pdfText(Math.round(rep.rows.reduce((s, x) => s + (parseFloat(x[c.key]) || 0), 0) * 100) / 100, c.type) : (i === 0 ? 'TOTAL' : '')), true, false);
        }
        if (rep.rows.length === 0) { doc.fillColor('#555').font('Helvetica').fontSize(10).text('No records for this period.', left, y + 8); }

        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            doc.fillColor('#777').font('Helvetica').fontSize(8)
               .text(`Page ${i + 1} of ${range.count}   |   Generated ${niceDate(todayStr())}   |   KEY ARCH`, left, doc.page.height - doc.page.margins.bottom + 6,
                     { width: usable, align: 'center', lineBreak: false });
        }
        doc.end();
    }

    app.get('/api/reports/export', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        try {
            const rep = await buildReport(req);
            const base = `${rep.type}-${rep.from}-to-${rep.to}`;
            if (req.query.format === 'pdf') return writeReportPdf(res, base + '.pdf', rep);
            await writeWorkbookTo(res, base + '.xlsx', [{
                name: rep.title, heading: [rep.company_name, rep.title, `Period: ${rep.period}   |   ${rep.property}`],
                summary: rep.summary, columns: rep.columns, rows: rep.rows
            }]);
        } catch (err) {
            if (!err.status) console.error('Report export error:', err);
            if (!res.headersSent) res.status(err.status || (err.code === 'MISSING_PACKAGE' ? 501 : 500)).json({ error: err.message, code: err.code });
            else res.end();
        }
    });
    return { writeReportPdf, writeWorkbookTo };
};

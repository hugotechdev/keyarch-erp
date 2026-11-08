// EXPENSES
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_MONEY, R_VIEW_MONEY, allowRoles, app, authenticateToken, checkAccount, cleanCur, createAuditLog, guard, inScope, isDateStr, pool, scopeSql, scoped, todayStr, wrapAsync } = ctx;


    // ============================================================
    // EXPENSES
    // ============================================================
    const EXPENSE_CATEGORIES = ['REPAIR', 'UTILITY', 'TAX', 'SALARY', 'SUPPLIES', 'SECURITY', 'CLEANING', 'INSURANCE', 'MARKETING', 'MISC'];

    app.get('/api/expenses', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const params = [req.user.company_id];
        let where = '';
        if (isDateStr(req.query.from)) { params.push(req.query.from); where += ` AND e.expense_date >= $${params.length}`; }
        if (isDateStr(req.query.to)) { params.push(req.query.to); where += ` AND e.expense_date <= $${params.length}`; }
        if (req.query.property_id) { params.push(req.query.property_id); where += ` AND e.property_id = $${params.length}`; }
        if (req.query.category) { params.push(req.query.category); where += ` AND e.category = $${params.length}`; }
        where += scopeSql(req, 'e.property_id', params);
        const rows = (await pool.query(
            `SELECT e.expense_id, e.description, e.amount, e.category, e.expense_date, e.property_id, e.payee, e.notes, e.ticket_id, COALESCE(e.currency, 'TZS') AS currency, e.account_id, fa.name AS account_name,
                    COALESCE(p.property_name, p.title) AS property_name, u.full_name AS recorded_by_name
             FROM expenses e LEFT JOIN properties p ON p.property_id = e.property_id LEFT JOIN users u ON u.user_id = e.recorded_by LEFT JOIN finance_accounts fa ON fa.account_id = e.account_id
             WHERE e.company_id = $1 ${where} ORDER BY e.expense_date DESC, e.expense_id DESC LIMIT 1000`, params
        )).rows;
        const tz = rows.filter(r => r.currency === 'TZS');
        const total = tz.reduce((s, r) => s + parseFloat(r.amount), 0);
        const totalUsd = rows.filter(r => r.currency === 'USD').reduce((s, r) => s + parseFloat(r.amount), 0);
        const byCategory = {};
        tz.forEach(r => { byCategory[r.category] = (byCategory[r.category] || 0) + parseFloat(r.amount); });
        res.json({ total, total_usd: totalUsd, byCategory, rows });
    }));

    function readExpenseBody(b) {
        const amount = parseFloat(b.amount);
        if (!String(b.description || '').trim()) return { error: 'Please describe the expense.' };
        if (!(amount > 0)) return { error: 'Amount must be greater than 0.' };
        const category = EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'MISC';
        const date = isDateStr(b.expense_date) ? b.expense_date : todayStr();
        if (date > todayStr()) return { error: 'Expense date cannot be in the future.' };
        return { value: { currency: cleanCur(b.currency), account_id: b.account_id || null, description: String(b.description).trim(), amount, category, date, property_id: b.property_id || null, payee: String(b.payee || '').trim() || null, notes: String(b.notes || '').trim() || null } };
    }

    app.post('/api/expenses', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
        const r = readExpenseBody(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const v = r.value;
        if (scoped(req) && !inScope(req, v.property_id)) return res.status(403).json({ error: 'Choose one of your projects.', code: 'OUT_OF_SCOPE' });
        if (v.property_id) {
            const ok = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [v.property_id, req.user.company_id]);
            if (ok.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
        }
        const accId = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
        const ins = await pool.query(
            `INSERT INTO expenses (company_id, property_id, description, amount, category, recorded_by, expense_date, payee, notes, currency, account_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING expense_id`,
            [req.user.company_id, v.property_id, v.description, v.amount, v.category, req.user.user_id, v.date, v.payee, v.notes, v.currency, accId]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Recorded Expense', 'EXPENSES', req.ip, { expense_id: ins.rows[0].expense_id, amount: v.amount });
        res.status(201).json({ message: 'Expense saved.', expense_id: ins.rows[0].expense_id });
    }));

    app.put('/api/expenses/:id', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'expense', req.params.id))) return;
        const r = readExpenseBody(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const v = r.value;
        if (scoped(req) && !inScope(req, v.property_id)) return res.status(403).json({ error: 'Choose one of your projects.', code: 'OUT_OF_SCOPE' });
        const accId = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
        const upd = await pool.query(
            `UPDATE expenses SET property_id = $1, description = $2, amount = $3, category = $4, expense_date = $5, payee = $6, notes = $7, currency = $10, account_id = $11
             WHERE expense_id = $8 AND company_id = $9 RETURNING expense_id`,
            [v.property_id, v.description, v.amount, v.category, v.date, v.payee, v.notes, req.params.id, req.user.company_id, v.currency, accId]
        );
        if (upd.rows.length === 0) return res.status(404).json({ error: 'Expense not found.' });
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Expense', 'EXPENSES', req.ip, { expense_id: req.params.id });
        res.json({ message: 'Expense updated.' });
    }));

    app.delete('/api/expenses/:id', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'expense', req.params.id))) return;
        const r = await pool.query('DELETE FROM expenses WHERE expense_id = $1 AND company_id = $2 RETURNING expense_id', [req.params.id, req.user.company_id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Expense not found.' });
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Expense', 'EXPENSES', req.ip, { expense_id: req.params.id });
        res.json({ message: 'Expense deleted.' });
    }));
    return {};
};

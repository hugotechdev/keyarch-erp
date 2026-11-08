// FINANCE (accountant's small finance system)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_FIN_VIEW, R_FIN_WRITE, allowRoles, app, authenticateToken, checkAccount, cleanCur, companyWide, createAuditLog, isDateStr, niceDate, pool, todayStr, wrapAsync, writeReportPdf, writeWorkbookTo } = ctx;



    // ============================================================
    // FINANCE (accountant's small finance system)
    // Accounts, manual income, one ledger of every money movement, reports to PDF / Excel
    // ============================================================
    const INCOME_CATEGORIES = ['RENT', 'DEPOSIT', 'SERVICE', 'LUKU', 'INTEREST', 'SALE', 'OTHER'];

    app.get('/api/finance/accounts', authenticateToken, companyWide, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        const rows = (await pool.query(
            `SELECT a.account_id, a.name, a.currency, a.kind, a.opening_balance, a.is_active, a.created_at,
                    COALESCE((SELECT SUM(COALESCE(received_amount, amount_paid)) FROM payments WHERE account_id = a.account_id AND company_id = $1), 0) AS rent_in,
                    COALESCE((SELECT SUM(amount) FROM finance_income WHERE account_id = a.account_id AND company_id = $1), 0) AS other_in,
                    COALESCE((SELECT SUM(amount) FROM expenses WHERE account_id = a.account_id AND company_id = $1), 0) AS spent
             FROM finance_accounts a WHERE a.company_id = $1 ORDER BY a.is_active DESC, a.currency, a.name`, [cId]
        )).rows;
        const canSee = req.user.role !== 'PROPERTY_MANAGER';
        res.json(rows.map(r => {
            const inn = parseFloat(r.rent_in) + parseFloat(r.other_in), out = parseFloat(r.spent), open = parseFloat(r.opening_balance);
            const o = { account_id: r.account_id, name: r.name, currency: r.currency, kind: r.kind, is_active: r.is_active };
            if (canSee) Object.assign(o, { opening_balance: open, money_in: inn, money_out: out, balance: Math.round((open + inn - out) * 100) / 100 });
            return o;
        }));
    }));

    function readAccountBody(b) {
        const name = String(b.name || '').trim().slice(0, 100);
        if (!name) return { error: 'Please give the account a name.' };
        const opening = b.opening_balance === undefined || b.opening_balance === '' ? 0 : parseFloat(b.opening_balance);
        if (isNaN(opening)) return { error: 'Opening balance must be a number.' };
        const kind = ['CASH', 'BANK', 'MOBILE', 'OTHER'].includes(b.kind) ? b.kind : 'CASH';
        return { value: { name, currency: cleanCur(b.currency), kind, opening } };
    }

    app.post('/api/finance/accounts', authenticateToken, companyWide, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
        const r = readAccountBody(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const v = r.value;
        const dup = await pool.query('SELECT 1 FROM finance_accounts WHERE company_id = $1 AND LOWER(name) = LOWER($2) AND currency = $3', [req.user.company_id, v.name, v.currency]);
        if (dup.rows.length) return res.status(400).json({ error: 'You already have an account with this name and currency.' });
        const ins = await pool.query(
            'INSERT INTO finance_accounts (company_id, name, currency, kind, opening_balance, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING account_id',
            [req.user.company_id, v.name, v.currency, v.kind, v.opening, req.user.user_id]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Created Finance Account', 'FINANCE', req.ip, { account_id: ins.rows[0].account_id, name: v.name });
        res.status(201).json({ message: 'Account created.', account_id: ins.rows[0].account_id });
    }));

    app.put('/api/finance/accounts/:id', authenticateToken, companyWide, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
        const r = readAccountBody(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const v = r.value;
        const cur = (await pool.query('SELECT currency FROM finance_accounts WHERE account_id = $1 AND company_id = $2', [req.params.id, req.user.company_id])).rows[0];
        if (!cur) return res.status(404).json({ error: 'Account not found.' });
        if (cur.currency !== v.currency) {
            const used = await pool.query(
                `SELECT (SELECT COUNT(*) FROM payments WHERE account_id = $1) + (SELECT COUNT(*) FROM expenses WHERE account_id = $1) + (SELECT COUNT(*) FROM finance_income WHERE account_id = $1) AS n`, [req.params.id]);
            if (parseInt(used.rows[0].n) > 0) return res.status(400).json({ error: 'The currency cannot be changed because this account already has records.' });
        }
        await pool.query('UPDATE finance_accounts SET name = $1, currency = $2, kind = $3, opening_balance = $4, is_active = $5 WHERE account_id = $6 AND company_id = $7',
            [v.name, v.currency, v.kind, v.opening, req.body.is_active === false ? false : true, req.params.id, req.user.company_id]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Finance Account', 'FINANCE', req.ip, { account_id: req.params.id });
        res.json({ message: 'Account saved.' });
    }));

    app.delete('/api/finance/accounts/:id', authenticateToken, companyWide, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
        const used = await pool.query(
            `SELECT (SELECT COUNT(*) FROM payments WHERE account_id = $1) + (SELECT COUNT(*) FROM expenses WHERE account_id = $1) + (SELECT COUNT(*) FROM finance_income WHERE account_id = $1) AS n`, [req.params.id]);
        if (parseInt(used.rows[0].n) > 0) {
            const c = await pool.query('UPDATE finance_accounts SET is_active = false WHERE account_id = $1 AND company_id = $2 RETURNING account_id', [req.params.id, req.user.company_id]);
            if (!c.rows.length) return res.status(404).json({ error: 'Account not found.' });
            return res.json({ message: 'This account has records, so it was closed (hidden from new entries) instead of deleted.', closed: true });
        }
        const d = await pool.query('DELETE FROM finance_accounts WHERE account_id = $1 AND company_id = $2 RETURNING account_id', [req.params.id, req.user.company_id]);
        if (!d.rows.length) return res.status(404).json({ error: 'Account not found.' });
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Finance Account', 'FINANCE', req.ip, { account_id: req.params.id });
        res.json({ message: 'Account deleted.' });
    }));

    // ---- manual income (money that is not a tenant invoice payment)
    function readIncomeBody(b) {
        const amount = parseFloat(b.amount);
        if (!String(b.description || '').trim()) return { error: 'Please describe the income.' };
        if (!(amount > 0)) return { error: 'Amount must be greater than 0.' };
        const date = isDateStr(b.income_date) ? b.income_date : todayStr();
        if (date > todayStr()) return { error: 'Income date cannot be in the future.' };
        return { value: { description: String(b.description).trim(), amount, currency: cleanCur(b.currency), account_id: b.account_id || null,
            category: INCOME_CATEGORIES.includes(b.category) ? b.category : 'OTHER', date, property_id: b.property_id || null,
            payer: String(b.payer || '').trim() || null, reference: String(b.reference || '').trim().slice(0, 100) || null, notes: String(b.notes || '').trim() || null } };
    }
    async function checkPropertyOwn(companyId, propertyId) {
        if (!propertyId) return;
        const ok = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [propertyId, companyId]);
        if (!ok.rows.length) { const e = new Error('Property not found.'); e.status = 404; throw e; }
    }
    app.post('/api/finance/income', authenticateToken, companyWide, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
        const r = readIncomeBody(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const v = r.value;
        await checkPropertyOwn(req.user.company_id, v.property_id);
        const acc = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
        const ins = await pool.query(
            `INSERT INTO finance_income (company_id, account_id, property_id, description, amount, currency, category, income_date, payer, reference, notes, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING income_id`,
            [req.user.company_id, acc, v.property_id, v.description, v.amount, v.currency, v.category, v.date, v.payer, v.reference, v.notes, req.user.user_id]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Recorded Income', 'FINANCE', req.ip, { income_id: ins.rows[0].income_id, amount: v.amount, currency: v.currency });
        res.status(201).json({ message: 'Income saved.', income_id: ins.rows[0].income_id });
    }));
    app.put('/api/finance/income/:id', authenticateToken, companyWide, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
        const r = readIncomeBody(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const v = r.value;
        await checkPropertyOwn(req.user.company_id, v.property_id);
        const acc = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
        const u = await pool.query(
            `UPDATE finance_income SET account_id = $1, property_id = $2, description = $3, amount = $4, currency = $5, category = $6, income_date = $7, payer = $8, reference = $9, notes = $10
             WHERE income_id = $11 AND company_id = $12 RETURNING income_id`,
            [acc, v.property_id, v.description, v.amount, v.currency, v.category, v.date, v.payer, v.reference, v.notes, req.params.id, req.user.company_id]);
        if (!u.rows.length) return res.status(404).json({ error: 'Income record not found.' });
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Income', 'FINANCE', req.ip, { income_id: req.params.id });
        res.json({ message: 'Income updated.' });
    }));
    app.delete('/api/finance/income/:id', authenticateToken, companyWide, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
        const d = await pool.query('DELETE FROM finance_income WHERE income_id = $1 AND company_id = $2 RETURNING income_id', [req.params.id, req.user.company_id]);
        if (!d.rows.length) return res.status(404).json({ error: 'Income record not found.' });
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Income', 'FINANCE', req.ip, { income_id: req.params.id });
        res.json({ message: 'Income deleted.' });
    }));

    // ---- the ledger: every shilling and dollar in and out, with filters
    const idList = v => String(v || '').split(',').map(x => parseInt(x, 10)).filter(x => x > 0);

    async function buildLedger(req) {
        const cId = req.user.company_id;
        const q = req.query;
        const to = isDateStr(q.to) ? q.to : todayStr();
        const from = isDateStr(q.from) ? q.from : to.slice(0, 8) + '01';
        const cur = ['TZS', 'USD'].includes(String(q.currency || '').toUpperCase()) ? String(q.currency).toUpperCase() : 'ALL';
        const props = idList(q.property_ids), units = idList(q.unit_ids);
        const accountId = parseInt(q.account_id, 10) || null;
        const kind = ['income', 'expense'].includes(q.kind) ? q.kind : 'all';
        const group = ['day', 'week', 'month', 'year'].includes(q.group) ? q.group : 'month';
        const wantLuku = q.luku !== '0';

        const rows = [];
        const bind = (arr, v) => { arr.push(v); return '$' + arr.length; };

        if (kind !== 'expense') {
            // rent / invoice payments
            const a = [cId, from, to];
            let w = ' AND py.payment_date::date BETWEEN $2 AND $3';
            if (cur !== 'ALL') w += ` AND COALESCE(py.received_currency, py.currency, 'TZS') = ${bind(a, cur)}`;
            if (props.length) w += ` AND p.property_id = ANY(${bind(a, props)}::int[])`;
            if (units.length) w += ` AND u.unit_id = ANY(${bind(a, units)}::int[])`;
            if (accountId) w += ` AND py.account_id = ${bind(a, accountId)}`;
            const r1 = await pool.query(
                `SELECT py.payment_id, py.payment_date::date AS date, COALESCE(py.received_amount, py.amount_paid) AS amount, COALESCE(py.received_currency, py.currency, 'TZS') AS currency, py.account_id, fa.name AS account_name,
                        py.receipt_number, py.payment_method, inv.invoice_type, inv.invoice_number, t.full_name AS tenant_name, u.unit_id, u.unit_number,
                        p.property_id, COALESCE(p.property_name, p.title) AS property_name
                 FROM payments py JOIN invoices inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
                 JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                 LEFT JOIN finance_accounts fa ON fa.account_id = py.account_id
                 WHERE py.company_id = $1 ${w} ORDER BY py.payment_date DESC LIMIT 20000`, a);
            r1.rows.forEach(r => rows.push({
                id: 'P' + r.payment_id, type: 'INCOME', source: 'PAYMENT', date: String(r.date).slice(0, 10), category: r.invoice_type || 'RENT',
                description: `${r.tenant_name} - ${r.invoice_number}${r.receipt_number ? ' (' + r.receipt_number + ')' : ''}`,
                property_id: r.property_id, property: r.property_name, unit_id: r.unit_id, unit: r.unit_number, account_id: r.account_id, account: r.account_name || '',
                currency: r.currency, amount: parseFloat(r.amount), reference: r.receipt_number || '', payment_id: r.payment_id }));

            // other income (manual)
            if (!units.length) {
                const b = [cId, from, to];
                let w2 = ' AND fi.income_date BETWEEN $2 AND $3';
                if (cur !== 'ALL') w2 += ` AND fi.currency = ${bind(b, cur)}`;
                if (props.length) w2 += ` AND fi.property_id = ANY(${bind(b, props)}::int[])`;
                if (accountId) w2 += ` AND fi.account_id = ${bind(b, accountId)}`;
                const r2 = await pool.query(
                    `SELECT fi.*, fa.name AS account_name, COALESCE(p.property_name, p.title) AS property_name
                     FROM finance_income fi LEFT JOIN finance_accounts fa ON fa.account_id = fi.account_id LEFT JOIN properties p ON p.property_id = fi.property_id
                     WHERE fi.company_id = $1 ${w2} ORDER BY fi.income_date DESC LIMIT 20000`, b);
                r2.rows.forEach(r => rows.push({
                    id: 'I' + r.income_id, type: 'INCOME', source: 'MANUAL', date: String(r.income_date).slice(0, 10), category: r.category,
                    description: r.description + (r.payer ? ' - ' + r.payer : ''), property_id: r.property_id, property: r.property_name || '', unit_id: null, unit: '',
                    account_id: r.account_id, account: r.account_name || '', currency: r.currency, amount: parseFloat(r.amount), reference: r.reference || '', income_id: r.income_id, raw: r.description, party: r.payer || '', notes: r.notes || '' }));
            }

            // Luku (electricity token) sales are in TSh and are not tied to a property
            if (wantLuku && !props.length && !units.length && !accountId && cur !== 'USD') {
                try {
                    const r3 = await pool.query(
                        `SELECT voucher_id, sold_at::date AS date, amount, tenant_name, unit_name, meter_number
                         FROM luku_vouchers WHERE company_id = $1 AND sold_at IS NOT NULL AND sold_at::date BETWEEN $2 AND $3 ORDER BY sold_at DESC LIMIT 20000`, [cId, from, to]);
                    r3.rows.forEach(r => rows.push({
                        id: 'L' + r.voucher_id, type: 'INCOME', source: 'LUKU', date: String(r.date).slice(0, 10), category: 'LUKU',
                        description: `Luku ${r.meter_number || ''} - ${r.tenant_name || r.unit_name || ''}`.trim(), property_id: null, property: '', unit_id: null, unit: r.unit_name || '',
                        account_id: null, account: '', currency: 'TZS', amount: parseFloat(r.amount), reference: '' }));
                } catch (e) { /* no luku table yet: skip */ }
            }
        }

        if (kind !== 'income' && !units.length) {   // expenses are not tied to a unit, so a unit filter leaves them out
            const a = [cId, from, to];
            let w = ' AND e.expense_date BETWEEN $2 AND $3';
            if (cur !== 'ALL') w += ` AND COALESCE(e.currency, 'TZS') = ${bind(a, cur)}`;
            if (props.length) w += ` AND e.property_id = ANY(${bind(a, props)}::int[])`;
            if (accountId) w += ` AND e.account_id = ${bind(a, accountId)}`;
            const r4 = await pool.query(
                `SELECT e.*, COALESCE(e.currency, 'TZS') AS cur, fa.name AS account_name, COALESCE(p.property_name, p.title) AS property_name
                 FROM expenses e LEFT JOIN finance_accounts fa ON fa.account_id = e.account_id LEFT JOIN properties p ON p.property_id = e.property_id
                 WHERE e.company_id = $1 ${w} ORDER BY e.expense_date DESC LIMIT 20000`, a);
            r4.rows.forEach(r => rows.push({
                id: 'E' + r.expense_id, type: 'EXPENSE', source: 'EXPENSE', date: String(r.expense_date).slice(0, 10), category: r.category,
                description: r.description + (r.payee ? ' - ' + r.payee : ''), property_id: r.property_id, property: r.property_name || '', unit_id: null, unit: '',
                account_id: r.account_id, account: r.account_name || '', currency: r.cur, amount: parseFloat(r.amount), reference: '', expense_id: r.expense_id, raw: r.description, party: r.payee || '', notes: r.notes || '' }));
        }

        rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));

        // totals per currency, by category, account and source, and a time series
        const round2 = n => Math.round(n * 100) / 100;
        const totals = {};
        const ensure = c => (totals[c] = totals[c] || { income: 0, expense: 0, net: 0 });
        const byCategory = {}, byAccount = {}, bySource = {}, series = {};
        const periodKey = d => {
            if (group === 'day') return d;
            if (group === 'year') return d.slice(0, 4);
            if (group === 'month') return d.slice(0, 7);
            const dt = new Date(d + 'T00:00:00Z'); const wd = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - wd);
            return dt.toISOString().slice(0, 10);
        };
        rows.forEach(r => {
            const t = ensure(r.currency), isIn = r.type === 'INCOME';
            t[isIn ? 'income' : 'expense'] += r.amount;
            const ck = `${r.type}|${r.category}|${r.currency}`;
            byCategory[ck] = byCategory[ck] || { type: r.type, category: r.category, currency: r.currency, total: 0 }; byCategory[ck].total += r.amount;
            const ak = `${r.account_id || 0}|${r.currency}`;
            byAccount[ak] = byAccount[ak] || { account_id: r.account_id, account: r.account || '(no account)', currency: r.currency, income: 0, expense: 0 };
            byAccount[ak][isIn ? 'income' : 'expense'] += r.amount;
            const sk = `${r.source}|${r.currency}`;
            bySource[sk] = bySource[sk] || { source: r.source, currency: r.currency, total: 0 }; bySource[sk].total += r.amount;
            const pk = `${periodKey(r.date)}|${r.currency}`;
            series[pk] = series[pk] || { period: periodKey(r.date), currency: r.currency, income: 0, expense: 0 };
            series[pk][isIn ? 'income' : 'expense'] += r.amount;
        });
        Object.values(totals).forEach(t => { t.income = round2(t.income); t.expense = round2(t.expense); t.net = round2(t.income - t.expense); });
        const fix = o => Object.values(o).map(x => { Object.keys(x).forEach(k => { if (typeof x[k] === 'number' && k !== 'account_id') x[k] = round2(x[k]); }); return x; });
        const company = (await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [cId])).rows[0] || {};
        return {
            from, to, currency: cur, group, kind, company_name: company.company_name || '', property_ids: props, unit_ids: units, account_id: accountId,
            totals, rows: rows.slice(0, 5000), row_count: rows.length, truncated: rows.length > 5000,
            by_category: fix(byCategory), by_account: fix(byAccount), by_source: fix(bySource), series: fix(series).sort((x, y) => (x.period < y.period ? -1 : 1))
        };
    }

    app.get('/api/finance/ledger', authenticateToken, companyWide, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
        res.json(await buildLedger(req));
    }));

    // units for the filter (all units of the chosen properties)
    app.get('/api/finance/units', authenticateToken, companyWide, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
        const props = idList(req.query.property_ids);
        const a = [req.user.company_id]; let w = '';
        if (props.length) { a.push(props); w = ' AND u.property_id = ANY($2::int[])'; }
        const rows = (await pool.query(
            `SELECT u.unit_id, u.unit_number, u.property_id, COALESCE(p.property_name, p.title) AS property_name
             FROM units u JOIN properties p ON p.property_id = u.property_id WHERE u.company_id = $1 ${w} ORDER BY p.property_id, u.unit_number LIMIT 2000`, a)).rows;
        res.json(rows);
    }));

    // Quick review for the top of the Finance page: this month and this year, one block per currency
    app.get('/api/finance/overview', authenticateToken, companyWide, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
        const t = todayStr();
        const mk = async (from) => (await buildLedger({ user: req.user, query: { from, to: t, currency: 'ALL', kind: 'all', group: 'month' } }));
        const month = await mk(t.slice(0, 8) + '01'), year = await mk(t.slice(0, 5) + '01-01');
        // the whole previous month, to show whether this month is going up or down
        const first = new Date(t.slice(0, 8) + '01T00:00:00Z'); const pEnd = new Date(first.getTime() - 86400000), pStart = new Date(Date.UTC(pEnd.getUTCFullYear(), pEnd.getUTCMonth(), 1));
        const prev = await buildLedger({ user: req.user, query: { from: pStart.toISOString().slice(0, 10), to: pEnd.toISOString().slice(0, 10), currency: 'ALL', kind: 'all', group: 'month' } });
        const out = { today: t, TZS: {}, USD: {} };
        ['TZS', 'USD'].forEach(c => {
            const m = month.totals[c] || { income: 0, expense: 0 }, y = year.totals[c] || { income: 0, expense: 0 }, pv = prev.totals[c] || { income: 0, expense: 0 };
            out[c] = { month_income: m.income, month_expense: m.expense, year_income: y.income, year_expense: y.expense, prev_income: pv.income, prev_expense: pv.expense };
        });
        res.json(out);
    }));

    function ledgerReport(L, view) {
        const periodLabel = `${niceDate(L.from)} - ${niceDate(L.to)}`;
        const summary = [];
        Object.keys(L.totals).sort().forEach(c => {
            summary.push({ label: `${c} income`, value: L.totals[c].income, type: 'money' });
            summary.push({ label: `${c} expenses`, value: L.totals[c].expense, type: 'money' });
            summary.push({ label: `${c} net`, value: L.totals[c].net, type: 'money' });
        });
        const single = L.currency !== 'ALL';
        let columns, rows, title;
        if (view === 'summary') {
            title = 'Income and expenses summary';
            columns = [{ key: 'period', label: 'Period', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
                       { key: 'income', label: 'Income', type: 'money', total: single }, { key: 'expense', label: 'Expenses', type: 'money', total: single },
                       { key: 'net', label: 'Net', type: 'money', total: single }];
            rows = L.series.map(x => ({ period: x.period, currency: x.currency, income: x.income, expense: x.expense, net: Math.round((x.income - x.expense) * 100) / 100 }));
        } else if (view === 'accounts') {
            title = 'Accounts report';
            columns = [{ key: 'account', label: 'Account', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
                       { key: 'income', label: 'Money in', type: 'money', total: single }, { key: 'expense', label: 'Money out', type: 'money', total: single },
                       { key: 'net', label: 'Net', type: 'money', total: single }];
            rows = L.by_account.map(x => ({ account: x.account, currency: x.currency, income: x.income, expense: x.expense, net: Math.round((x.income - x.expense) * 100) / 100 }));
        } else {
            title = view === 'expenses' ? 'Expenses report' : view === 'income' ? 'Income report' : 'Finance statement';
            columns = [{ key: 'date', label: 'Date', type: 'date' }, { key: 'type', label: 'Type', type: 'text' }, { key: 'category', label: 'Category', type: 'text' },
                       { key: 'description', label: 'Description', type: 'text', wide: true }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
                       { key: 'account', label: 'Account', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
                       { key: 'income', label: 'Income', type: 'money', total: single }, { key: 'expense', label: 'Expense', type: 'money', total: single }];
            rows = L.rows.map(r => ({ date: r.date, type: r.type === 'INCOME' ? 'Income' : 'Expense', category: r.category, description: r.description, property: r.property, unit: r.unit,
                account: r.account, currency: r.currency, income: r.type === 'INCOME' ? r.amount : 0, expense: r.type === 'EXPENSE' ? r.amount : 0 }));
        }
        return { type: 'finance-' + view, title, company_name: L.company_name, period: periodLabel, property: L.property_ids.length ? `${L.property_ids.length} propert${L.property_ids.length === 1 ? 'y' : 'ies'} selected` : 'All properties',
                 from: L.from, to: L.to, summary, columns, rows };
    }

    app.get('/api/finance/export', authenticateToken, companyWide, allowRoles(...R_FIN_VIEW), async (req, res) => {
        try {
            const L = await buildLedger(req);
            const view = ['statement', 'summary', 'accounts', 'income', 'expenses'].includes(req.query.view) ? req.query.view : 'statement';
            const k = view === 'income' ? 'income' : view === 'expenses' ? 'expense' : null;
            if (k && L.kind === 'all') { L.rows = L.rows.filter(r => r.type === (k === 'income' ? 'INCOME' : 'EXPENSE')); }
            const rep = ledgerReport(L, view);
            const base = `finance-${view}-${L.from}-to-${L.to}`;
            if (req.query.format === 'pdf') return writeReportPdf(res, base + '.pdf', rep);
            await writeWorkbookTo(res, base + '.xlsx', [{
                name: rep.title, heading: [rep.company_name, rep.title, `Period: ${rep.period}   |   ${rep.property}`],
                summary: rep.summary, columns: rep.columns, rows: rep.rows }]);
        } catch (err) {
            if (!err.status) console.error('Finance export error:', err);
            if (!res.headersSent) res.status(err.status || (err.code === 'MISSING_PACKAGE' ? 501 : 500)).json({ error: err.message, code: err.code });
            else res.end();
        }
    });
    return {};
};

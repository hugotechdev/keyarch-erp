// SHARED HELPERS (invoices, payments, dates, roles)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { normalizePaymentMethod, payStatusOf } = ctx;


    // ============================================================
    // SHARED HELPERS (invoices, payments, dates, roles)
    // ============================================================
    const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    // Dates follow Tanzania time (UTC+3), so a payment recorded after midnight there is not called "future"
    function todayStr() { return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); }
    function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
    function niceDate(s) {            // 2026-11-05 -> 05 Nov 2026
        if (!isDateStr(String(s).slice(0, 10))) return s || '';
        const d = String(s).slice(0, 10);
        return `${d.slice(8, 10)} ${MONTHS_EN[parseInt(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
    }
    function monthLabel(ym) {         // 2026-11 -> November 2026
        return `${MONTHS_FULL[parseInt(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
    }
    function fmtMoney(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
    function periodWord(period, n) { return `${period}${Number(n) === 1 ? '' : 's'}`; }
    const wrapAsync = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
        console.error('Route error:', req.method, req.originalUrl, err.message);
        res.status(err.status || 500).json({ error: err.message });
    });

    // who can do what
    const R_ADMIN = ['SUPER_ADMIN', 'COMPANY_ADMIN'];
    const R_MANAGE = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'];
    const R_MONEY = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'];
    const R_VIEW_MONEY = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'VIEWER']; // everyone except MAINTENANCE_MANAGER
    const R_FIN_VIEW = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTANT', 'PROPERTY_MANAGER'];
    const R_FIN_WRITE = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTANT'];
    const CURRENCIES = ['TZS', 'USD'];
    const cleanCur = v => (String(v || '').toUpperCase() === 'USD' ? 'USD' : 'TZS');
    const R_TICKETS = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'MAINTENANCE_MANAGER'];
    const ALL_ROLES = ['COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'MAINTENANCE_MANAGER', 'VIEWER'];

    const INVOICE_TYPES = ['RENT', 'SERVICE', 'EXTENSION', 'DEPOSIT', 'UTILITY', 'PENALTY', 'REPAIR', 'OTHER'];
    const MANUAL_INVOICE_TYPES = ['RENT', 'SERVICE', 'DEPOSIT', 'UTILITY', 'PENALTY', 'REPAIR', 'OTHER'];

    // Creates an invoice with its own details. Used by onboarding, renew, extend, service charges and manual invoices.
    async function createInvoice(client, o) {
        const subtotal = Math.round(parseFloat(o.subtotal) * 100) / 100;
        const discount = Math.round(parseFloat(o.discount || 0) * 100) / 100;
        const total = Math.round((subtotal - discount) * 100) / 100;
        const seq = await client.query("SELECT nextval('invoice_seq')");
        const number = `INV-${new Date().getFullYear()}-${seq.rows[0].nextval}`;
        const issue = isDateStr(o.issueDate) ? o.issueDate : todayStr();
        const curRow = await client.query('SELECT COALESCE(currency, \'TZS\') AS currency FROM leases WHERE lease_id = $1', [o.leaseId]);
        const currency = cleanCur(o.currency || (curRow.rows[0] && curRow.rows[0].currency));
        const r = await client.query(
            `INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status, invoice_type, description, subtotal, discount,
                                   issue_date, period_start, period_end, notes, lease_charge, created_by, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
            [o.companyId, o.leaseId, number, total, o.dueDate || issue, o.status || (total <= 0 ? 'PAID' : 'PENDING'),
             o.type || 'RENT', o.description || null, subtotal, discount, issue,
             isDateStr(o.periodStart) ? o.periodStart : null, isDateStr(o.periodEnd) ? o.periodEnd : null,
             o.notes || null, o.leaseCharge !== false, o.userId || null, currency]
        );
        return r.rows[0];
    }

    // A finance account must belong to the company and use the same currency as the money going in or out.
    async function checkAccount(db, companyId, accountId, currency) {
        if (accountId === undefined || accountId === null || accountId === '') return null;
        const r = await db.query('SELECT currency, is_active FROM finance_accounts WHERE account_id = $1 AND company_id = $2', [accountId, companyId]);
        if (r.rows.length === 0) { const e = new Error('Account not found.'); e.status = 400; throw e; }
        if (r.rows[0].currency !== currency) { const e = new Error(`This account holds ${r.rows[0].currency}, but the money is in ${currency}. Choose an account in ${currency}.`); e.status = 400; throw e; }
        if (r.rows[0].is_active === false) { const e = new Error('This account is closed. Choose another one.'); e.status = 400; throw e; }
        return parseInt(accountId, 10);
    }

    // Saves a payment and gives it a receipt number (RCT-2026-100001)
    async function addPayment(client, o) {
        const seq = await client.query("SELECT nextval('receipt_seq')");
        const receipt = `RCT-${new Date().getFullYear()}-${seq.rows[0].nextval}`;
        let when = null;
        if (isDateStr(o.date) && o.date !== todayStr()) when = o.date + ' 12:00:00';
        const detail = o.methodDetail ? String(o.methodDetail).slice(0, 40) : null;
        const invCur = await client.query('SELECT COALESCE(currency, \'TZS\') AS currency FROM invoices WHERE invoice_id = $1', [o.invoiceId]);
        const currency = cleanCur(invCur.rows[0] && invCur.rows[0].currency);
        const recvCur = o.receivedCurrency && cleanCur(o.receivedCurrency) !== currency ? cleanCur(o.receivedCurrency) : null;
        const accountId = await checkAccount(client, o.companyId, o.accountId, recvCur || currency);
        const r = await client.query(
            `INSERT INTO payments (company_id, invoice_id, amount_paid, payment_date, payment_method, method_detail, reference_no, notes, receipt_number, recorded_by, currency, account_id, received_currency, received_amount, exchange_rate)
             VALUES ($1, $2, $3, COALESCE($4::timestamp, (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
            [o.companyId, o.invoiceId, o.amount, when, normalizePaymentMethod(o.method), detail,
             o.reference ? String(o.reference).slice(0, 100) : null, o.notes || null, receipt, o.userId || null, currency, accountId, recvCur, recvCur ? o.receivedAmount : null, recvCur ? o.rate : null]
        );
        return r.rows[0];
    }

    // After a payment on a lease invoice, keeps the lease totals in step
    async function syncLeasePayment(client, leaseId, companyId) {
        const r = await client.query(
            `UPDATE leases SET amount_paid = COALESCE((
                    SELECT SUM(py.amount_paid) FROM payments py JOIN invoices i ON py.invoice_id = i.invoice_id
                    WHERE i.lease_id = $1 AND i.company_id = $2 AND COALESCE(i.lease_charge, true) = true), 0)
             WHERE lease_id = $1 AND company_id = $2
             RETURNING COALESCE(total_to_pay, agreed_rent) AS to_pay, amount_paid`,
            [leaseId, companyId]
        );
        if (r.rows.length === 0) return null;
        const toPay = parseFloat(r.rows[0].to_pay || 0), paid = parseFloat(r.rows[0].amount_paid || 0);
        const status = payStatusOf(toPay, paid);
        await client.query('UPDATE leases SET amount_due = $1, payment_status = $2 WHERE lease_id = $3 AND company_id = $4',
            [Math.max(0, Math.round((toPay - paid) * 100) / 100), status, leaseId, companyId]);
        return status;
    }

    // 1 100 000 -> "One million one hundred thousand" (English, for receipts)
    function amountInWords(n) {
        n = Math.round(Number(n) || 0);
        if (n === 0) return 'Zero';
        const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
        const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
        const below1000 = (x) => {
            let s = '';
            if (x >= 100) { s += ones[Math.floor(x / 100)] + ' hundred'; x %= 100; if (x) s += ' and '; }
            if (x >= 20) { s += tens[Math.floor(x / 10)]; if (x % 10) s += '-' + ones[x % 10]; }
            else if (x > 0) s += ones[x];
            return s;
        };
        const scales = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
        let out = [];
        for (const [v, name] of scales) {
            if (n >= v) { out.push(below1000(Math.floor(n / v)) + ' ' + name); n %= v; }
        }
        if (n > 0) out.push(below1000(n));
        const text = out.join(', ');
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
    return { ALL_ROLES, MANUAL_INVOICE_TYPES, R_ADMIN, R_FIN_VIEW, R_FIN_WRITE, R_MANAGE, R_MONEY, R_TICKETS, R_VIEW_MONEY, addPayment, amountInWords, checkAccount, cleanCur, createInvoice, fmtMoney, isDateStr, monthLabel, niceDate, periodWord, syncLeasePayment, todayStr, wrapAsync };
};

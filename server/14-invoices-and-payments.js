// INVOICES, PAYMENTS, RECEIPTS
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { MANUAL_INVOICE_TYPES, R_ADMIN, R_MONEY, R_VIEW_MONEY, addPayment, allowRoles, amountInWords, app, authenticateToken, createAuditLog, createInvoice, fmtMoney, guard, isDateStr, loadOptional, niceDate, periodWord, pool, scopeSql, syncLeasePayment, todayStr, wrapAsync } = ctx;

    const sum = (rows, k) => rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0);

    // ============================================================
    // INVOICES, PAYMENTS, RECEIPTS
    // balance = invoice total - sum of its payments
    // ============================================================
    const INVOICE_BALANCES_SQL = `
        SELECT COALESCE(inv.currency, 'TZS') AS currency, inv.invoice_id, inv.invoice_number, inv.status, inv.due_date, inv.amount_due, inv.invoice_type, inv.description,
               inv.issue_date, TO_CHAR(inv.period_start, 'YYYY-MM') AS period_month, COALESCE(inv.discount, 0) AS discount, COALESCE(inv.lease_charge, true) AS lease_charge,
               COALESCE(pay.paid, 0) AS paid,
               inv.amount_due - COALESCE(pay.paid, 0) AS balance,
               (inv.due_date::date - CURRENT_DATE) AS days_left,
               l.lease_id, t.tenant_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
               u.unit_id, u.unit_number, p.property_id, COALESCE(p.property_name, p.title) AS property_name
        FROM invoices inv
        JOIN leases l ON inv.lease_id = l.lease_id
        JOIN tenants t ON l.tenant_id = t.tenant_id
        JOIN units u ON l.unit_id = u.unit_id
        JOIN properties p ON u.property_id = p.property_id
        LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay
               ON pay.invoice_id = inv.invoice_id
        WHERE inv.company_id = $1`;

    app.get('/api/invoices', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const ip = [req.user.company_id];
        const result = await pool.query(`${INVOICE_BALANCES_SQL} ${scopeSql(req, 'p.property_id', ip)} ORDER BY inv.invoice_id DESC LIMIT 1000`, ip);
        res.json(result.rows);
    }));

    app.post('/api/invoices/issue', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
        const { lease_id, invoice_type, description, amount, discount, issue_date, due_date, period_start, period_end, notes } = req.body;
        const subtotal = parseFloat(amount);
        const disc = parseFloat(discount || 0);
        const type = MANUAL_INVOICE_TYPES.includes(invoice_type) ? invoice_type : 'OTHER';
        if (!lease_id || !(subtotal > 0) || !isDateStr(due_date)) return res.status(400).json({ error: 'Tenant, amount and due date are required.' });
        if (isNaN(disc) || disc < 0 || disc > subtotal) return res.status(400).json({ error: 'Discount must be between 0 and the amount.' });
        if (type === 'OTHER' && !String(description || '').trim()) return res.status(400).json({ error: 'Please describe what this invoice is for.' });
        if (isDateStr(issue_date) && isDateStr(due_date) && due_date < issue_date) return res.status(400).json({ error: 'Due date cannot be before the issue date.' });

        const lease = await pool.query('SELECT 1 FROM leases WHERE lease_id = $1 AND company_id = $2', [lease_id, req.user.company_id]);
        if (lease.rows.length === 0) return res.status(404).json({ error: 'Tenant contract not found.' });
        if (!(await guard(req, res, 'lease', lease_id))) return;

        const labels = { RENT: 'Rent', SERVICE: 'Service charge', DEPOSIT: 'Deposit', UTILITY: 'Utility bill', PENALTY: 'Penalty / late fee', REPAIR: 'Repair / damage', OTHER: 'Other charge' };
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const inv = await createInvoice(client, {
                companyId: req.user.company_id, leaseId: lease_id, type, subtotal, discount: disc,
                description: String(description || '').trim() || labels[type],
                issueDate: issue_date, dueDate: due_date, periodStart: period_start, periodEnd: period_end,
                notes: String(notes || '').trim() || null, leaseCharge: false, userId: req.user.user_id
            });
            await createAuditLog(client, req.user.company_id, req.user.user_id, 'Issued Invoice', 'INVOICES', req.ip, { invoice_id: inv.invoice_id, type });
            await client.query('COMMIT');
            res.status(201).json(inv);
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally { if (client) client.release(); }
    }));

    // delete an invoice only when nobody paid it and it is not part of the tenant's rent contract
    app.delete('/api/invoices/:id', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
        if (!(await guard(req, res, 'invoice', req.params.id))) return;
        const inv = (await pool.query('SELECT invoice_id, COALESCE(lease_charge, true) AS lease_charge FROM invoices WHERE invoice_id = $1 AND company_id = $2', [req.params.id, req.user.company_id])).rows[0];
        if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
        if (inv.lease_charge) return res.status(400).json({ error: 'This invoice belongs to the rent contract. Edit or end the contract instead.' });
        const pays = (await pool.query('SELECT COUNT(*) AS c FROM payments WHERE invoice_id = $1', [inv.invoice_id])).rows[0].c;
        if (parseInt(pays) > 0) return res.status(400).json({ error: 'This invoice already has payments, so it cannot be deleted.' });
        await pool.query('DELETE FROM invoices WHERE invoice_id = $1 AND company_id = $2', [inv.invoice_id, req.user.company_id]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Invoice', 'INVOICES', req.ip, { invoice_id: inv.invoice_id });
        res.json({ message: 'Invoice deleted.' });
    }));

    // RECORD A PAYMENT AGAINST AN INVOICE (updates invoice, lease balance and status, creates the receipt)
    app.post('/api/payments/record', authenticateToken, allowRoles(...R_MONEY), async (req, res) => {
        const { invoice_id, amount, payment_method, payment_date, reference, notes } = req.body;
        let amt = Math.round(parseFloat(amount) * 100) / 100;
        if (!invoice_id || !(amt > 0)) return res.status(400).json({ error: 'Invoice and a valid amount are required.' });
        if (!(await guard(req, res, 'invoice', invoice_id))) return;
        // The customer may pay in the other currency: amount is then what was handed over, and the rate (TSh per 1 USD) turns it into the invoice currency
        const recvCur = ['TZS', 'USD'].includes(String(req.body.received_currency || '').toUpperCase()) ? String(req.body.received_currency).toUpperCase() : null;
        const rate = parseFloat(req.body.exchange_rate);
        let recvAmount = amt;
        if (payment_date && (!isDateStr(payment_date) || payment_date > todayStr())) return res.status(400).json({ error: 'Payment date cannot be in the future.' });

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const companyId = req.user.company_id;

            const invRes = await client.query(
                'SELECT invoice_id, lease_id, amount_due, COALESCE(lease_charge, true) AS lease_charge FROM invoices WHERE invoice_id = $1 AND company_id = $2 FOR UPDATE',
                [invoice_id, companyId]
            );
            if (invRes.rows.length === 0) throw new Error('Invoice not found.');
            const inv = invRes.rows[0];
            const invCurRow = await client.query('SELECT COALESCE(currency, \'TZS\') AS currency FROM invoices WHERE invoice_id = $1', [invoice_id]);
            const invCur = invCurRow.rows[0].currency;
            if (recvCur && recvCur !== invCur) {
                if (!(rate > 0)) throw new Error('Please enter the exchange rate (TSh for 1 USD).');
                amt = invCur === 'USD' ? Math.round(recvAmount / rate * 100) / 100 : Math.round(recvAmount * rate);
                if (!(amt > 0)) throw new Error('The converted amount is too small.');
            }

            const payment = await addPayment(client, {
                companyId, invoiceId: invoice_id, amount: amt, method: payment_method, methodDetail: payment_method,
                reference, notes: String(notes || '').trim() || null, date: payment_date, userId: req.user.user_id, accountId: req.body.account_id,
                receivedCurrency: recvCur, receivedAmount: recvAmount, rate
            });

            const sum = await client.query('SELECT COALESCE(SUM(amount_paid), 0) AS paid FROM payments WHERE invoice_id = $1 AND company_id = $2', [invoice_id, companyId]);
            const paidOnInvoice = parseFloat(sum.rows[0].paid);
            const invStatus = paidOnInvoice >= parseFloat(inv.amount_due) ? 'PAID' : 'PENDING';
            await client.query('UPDATE invoices SET status = $1 WHERE invoice_id = $2 AND company_id = $3', [invStatus, invoice_id, companyId]);

            // only the rent contract invoices change the contract totals (service charges, penalties etc. do not)
            let leaseStatus = null;
            if (inv.lease_charge) leaseStatus = await syncLeasePayment(client, inv.lease_id, companyId);

            await createAuditLog(client, companyId, req.user.user_id, 'Recorded Payment', 'PAYMENTS', req.ip, { invoice_id, amount: amt, receipt: payment.receipt_number });
            await client.query('COMMIT');
            res.status(201).json({ message: 'Payment recorded.', credited: amt, credited_currency: invCur, invoice_status: invStatus, payment_status: leaseStatus, payment_id: payment.payment_id, receipt_number: payment.receipt_number });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally {
            if (client) client.release();
        }
    });

    // list of payments (receipts)
    app.get('/api/payments', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const params = [req.user.company_id];
        let where = '';
        if (isDateStr(req.query.from)) { params.push(req.query.from); where += ` AND py.payment_date::date >= $${params.length}`; }
        if (isDateStr(req.query.to)) { params.push(req.query.to); where += ` AND py.payment_date::date <= $${params.length}`; }
        const rows = (await pool.query(
            `SELECT py.payment_id, py.receipt_number, py.amount_paid, py.payment_date, py.payment_method, py.method_detail, py.reference_no, COALESCE(py.currency, 'TZS') AS currency, py.account_id,
                    inv.invoice_id, inv.invoice_number, inv.invoice_type, t.full_name AS tenant_name, u.unit_number, COALESCE(p.property_name, p.title) AS property_name
             FROM payments py
             JOIN invoices inv ON py.invoice_id = inv.invoice_id
             JOIN leases l ON inv.lease_id = l.lease_id
             JOIN tenants t ON l.tenant_id = t.tenant_id
             JOIN units u ON l.unit_id = u.unit_id
             JOIN properties p ON u.property_id = p.property_id
             WHERE py.company_id = $1 ${where} ${scopeSql(req, 'u.property_id', params)}
             ORDER BY py.payment_date DESC, py.payment_id DESC LIMIT 500`, params
        )).rows;
        res.json(rows);
    }));

    const COMPANY_PROFILE_SQL = `SELECT company_name, address, phone, email, tin, payment_instructions, logo_data FROM companies WHERE company_id = $1`;
    function logoBuffer(dataUrl) {
        if (!dataUrl) return null;
        const m = /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/.exec(String(dataUrl));
        return m ? Buffer.from(m[1], 'base64') : null;
    }

    // THE RECEIPT OF ONE PAYMENT
    async function getReceiptData(cId, payId) {
        let pay = (await pool.query(
            `SELECT py.*, u2.full_name AS received_by FROM payments py LEFT JOIN users u2 ON u2.user_id = py.recorded_by
             WHERE py.payment_id = $1 AND py.company_id = $2`, [payId, cId]
        )).rows[0];
        if (!pay) { const e = new Error('Payment not found.'); e.status = 404; throw e; }

        // old payments (made before receipts existed) get their number now
        if (!pay.receipt_number) {
            const seq = await pool.query("SELECT nextval('receipt_seq')");
            pay.receipt_number = `RCT-${new Date(pay.payment_date).getFullYear()}-${seq.rows[0].nextval}`;
            await pool.query('UPDATE payments SET receipt_number = $1 WHERE payment_id = $2', [pay.receipt_number, pay.payment_id]);
        }

        const inv = (await pool.query(
            `SELECT inv.invoice_id, inv.invoice_number, inv.invoice_type, inv.description, inv.amount_due, COALESCE(inv.currency, 'TZS') AS currency,
                    t.full_name AS tenant_name, t.phone_number AS tenant_phone, u.unit_number, COALESCE(p.property_name, p.title) AS property_name
             FROM invoices inv JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id
             JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
             WHERE inv.invoice_id = $1 AND inv.company_id = $2`, [pay.invoice_id, cId]
        )).rows[0];
        const paidToDate = parseFloat((await pool.query(
            'SELECT COALESCE(SUM(amount_paid), 0) AS s FROM payments WHERE invoice_id = $1 AND payment_id <= $2',
            [pay.invoice_id, pay.payment_id]
        )).rows[0].s);
        const company = (await pool.query(COMPANY_PROFILE_SQL, [cId])).rows[0];
        const total = parseFloat(inv.amount_due);
        return {
            receipt_number: pay.receipt_number, payment_id: pay.payment_id, payment_date: pay.payment_date,
            amount_paid: parseFloat(pay.amount_paid), currency: inv.currency || 'TZS', received_currency: pay.received_currency || null, received_amount: pay.received_amount ? parseFloat(pay.received_amount) : null, exchange_rate: pay.exchange_rate ? parseFloat(pay.exchange_rate) : null, amount_words: amountInWords(pay.amount_paid) + (inv.currency === 'USD' ? ' US dollars only' : ' shillings only'),
            method: pay.method_detail || pay.payment_method, reference: pay.reference_no, notes: pay.notes, received_by: pay.received_by,
            invoice: { invoice_id: inv.invoice_id, invoice_number: inv.invoice_number, invoice_type: inv.invoice_type, description: inv.description, total },
            paid_to_date: paidToDate, balance_after: Math.max(0, Math.round((total - paidToDate) * 100) / 100), extra_paid: Math.max(0, Math.round((paidToDate - total) * 100) / 100),
            tenant_name: inv.tenant_name, tenant_phone: inv.tenant_phone, unit_number: inv.unit_number, property_name: inv.property_name, company
        };
    }
    app.get('/api/payments/:id/receipt', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        if (!(await guard(req, res, 'payment', req.params.id))) return;
        try { res.json(await getReceiptData(req.user.company_id, req.params.id)); }
        catch (err) { if (!err.status) console.error('Receipt error:', err); res.status(err.status || 500).json({ error: err.message }); }
    });

    // FULL INVOICE FOR PRINTING (built from the invoice's own details)
    async function getInvoicePrintData(cId, invId) {
        const row = (await pool.query(
            `SELECT inv.*, l.start_date AS lease_start, l.end_date AS lease_end, l.rent_price, l.rent_period, l.number_of_periods, l.total_rent AS lease_total_rent,
                    COALESCE(l.discount, 0) AS lease_discount, COALESCE(l.total_to_pay, l.agreed_rent) AS lease_to_pay,
                    t.full_name AS tenant_name, t.phone_number AS tenant_phone, t.nida_passport_no, t.identity_type,
                    u.unit_number, COALESCE(p.property_name, p.title) AS property_name, p.address AS property_address
             FROM invoices inv
             JOIN leases l ON inv.lease_id = l.lease_id
             JOIN tenants t ON l.tenant_id = t.tenant_id
             JOIN units u ON l.unit_id = u.unit_id
             JOIN properties p ON u.property_id = p.property_id
             WHERE inv.invoice_id = $1 AND inv.company_id = $2`, [invId, cId]
        )).rows[0];
        if (!row) { const e = new Error('Invoice not found.'); e.status = 404; throw e; }

        const payments = (await pool.query(
            `SELECT payment_id, receipt_number, amount_paid, payment_date, payment_method, method_detail, reference_no
             FROM payments WHERE invoice_id = $1 AND company_id = $2 ORDER BY payment_date, payment_id`, [row.invoice_id, cId]
        )).rows;
        const paid = payments.reduce((s, p) => s + parseFloat(p.amount_paid), 0);
        const total = parseFloat(row.amount_due);
        const discount = parseFloat(row.discount || 0);
        // invoices made before v6 have no saved details: rebuild them from the contract
        let subtotal = row.subtotal !== null && row.subtotal !== undefined ? parseFloat(row.subtotal) : total + discount;
        let description = row.description;
        if (!description) {
            description = (row.invoice_type || 'RENT') === 'RENT' && row.rent_price
                ? `Rent: ${parseFloat(row.number_of_periods || 1)} ${periodWord(row.rent_period || 'Month', row.number_of_periods || 1)} x ${fmtMoney(row.rent_price)} (${niceDate(row.lease_start)} - ${niceDate(row.lease_end)})`
                : 'Rent charges';
        }
        const company = (await pool.query(COMPANY_PROFILE_SQL, [cId])).rows[0];
        return {
            invoice: {
                invoice_id: row.invoice_id, invoice_number: row.invoice_number, invoice_type: row.invoice_type || 'RENT', status: row.status,
                issue_date: row.issue_date || String(row.created_at).slice(0, 10), due_date: row.due_date, period_start: row.period_start, period_end: row.period_end,
                currency: row.currency || 'TZS', notes: row.notes, description, subtotal, discount, total, paid, balance: Math.round((total - paid) * 100) / 100
            },
            lines: [{ description, amount: subtotal }],
            payments,
            tenant: { name: row.tenant_name, phone: row.tenant_phone, id_type: row.identity_type, id_number: row.nida_passport_no },
            unit_number: row.unit_number, property_name: row.property_name, property_address: row.property_address,
            company
        };
    }
    app.get('/api/invoices/:id/print', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        if (!(await guard(req, res, 'invoice', req.params.id))) return;
        try { res.json(await getInvoicePrintData(req.user.company_id, req.params.id)); }
        catch (err) { if (!err.status) console.error('Invoice print error:', err); res.status(err.status || 500).json({ error: err.message }); }
    });

    // ---- PDF of one invoice / one receipt (logo + company details on top) ----
    function pdfHeader(doc, company, title, numberLine) {
        const left = doc.page.margins.left, usable = doc.page.width - left - doc.page.margins.right;
        let textX = left;
        const logo = logoBuffer(company && company.logo_data);
        if (logo) { try { doc.image(logo, left, 40, { fit: [70, 70] }); textX = left + 82; } catch (e) { /* bad picture: skip it */ } }
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text((company && company.company_name) || '', textX, 42, { width: usable - 190 });
        doc.font('Helvetica').fontSize(9).fillColor('#555');
        [company && company.address, company && company.phone, company && company.email, company && company.tin ? 'TIN: ' + company.tin : ''].filter(Boolean)
            .forEach(l => doc.text(String(l), textX, doc.y, { width: usable - 190 }));
        doc.fillColor('#1F3A5F').font('Helvetica-Bold').fontSize(22).text(title, left, 42, { width: usable, align: 'right' });
        doc.fillColor('#333').font('Helvetica').fontSize(10).text(numberLine, left, 70, { width: usable, align: 'right' });
        doc.y = Math.max(doc.y, 125);
        doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).strokeColor('#1F3A5F').lineWidth(1.5).stroke();
        doc.moveDown(0.8);
    }
    function pdfKV(doc, x, y, label, value, w) {
        doc.fillColor('#777').font('Helvetica').fontSize(8).text(label.toUpperCase(), x, y, { width: w });
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(String(value === undefined || value === null || value === '' ? '-' : value), x, doc.y, { width: w });
    }
    function writeInvoicePdf(res, filename, d) {
        const PDFDocument = loadOptional('pdfkit');
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);
        const left = doc.page.margins.left, usable = doc.page.width - left - doc.page.margins.right;
        const inv = d.invoice;
        pdfHeader(doc, d.company, 'INVOICE', inv.invoice_number);
        let y = doc.y;
        const colW = usable / 3 - 8;
        pdfKV(doc, left, y, 'Billed to', d.tenant.name, colW);
        doc.fillColor('#555').font('Helvetica').fontSize(9).text(d.tenant.phone || '', left, doc.y, { width: colW });
        pdfKV(doc, left + colW + 12, y, 'Property / unit', `${d.property_name} - ${d.unit_number}`, colW);
        pdfKV(doc, left + 2 * (colW + 12), y, 'Issue date', niceDate(inv.issue_date), colW);
        doc.fillColor('#777').font('Helvetica').fontSize(8).text('DUE DATE', left + 2 * (colW + 12), doc.y + 4, { width: colW });
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(inv.due_date ? niceDate(inv.due_date) : '-', left + 2 * (colW + 12), doc.y, { width: colW });
        doc.y = Math.max(doc.y, y + 70) + 6;

        // lines table
        y = doc.y;
        doc.save().rect(left, y, usable, 20).fill('#1F3A5F').restore();
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text('Description', left + 6, y + 6).text('Amount (' + (inv.currency || 'TZS') + ')', left, y + 6, { width: usable - 6, align: 'right' });
        y += 24;
        (d.lines || []).forEach(l => {
            const h = doc.heightOfString(l.description || '', { width: usable - 140 });
            doc.fillColor('#111').font('Helvetica').fontSize(10).text(l.description || '', left + 6, y, { width: usable - 140 });
            doc.text(fmtMoney(l.amount), left, y, { width: usable - 6, align: 'right' });
            y += Math.max(h, 14) + 8;
        });
        doc.moveTo(left, y).lineTo(left + usable, y).strokeColor('#ccc').lineWidth(0.5).stroke();
        y += 8;
        const totalRow = (label, val, bold, color) => {
            doc.fillColor(color || '#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10)
               .text(label, left + usable - 260, y, { width: 150 }).text(fmtMoney(val), left + usable - 110, y, { width: 104, align: 'right' });
            y += bold ? 20 : 16;
        };
        if (inv.discount > 0) { totalRow('Subtotal', inv.subtotal); totalRow('Discount', -inv.discount); }
        totalRow('Total', inv.total, true);
        totalRow('Paid', inv.paid, false, '#166534');
        totalRow('Balance due', inv.balance, true, inv.balance > 0 ? '#B91C1C' : '#166534');
        doc.y = y + 8;

        if (d.payments && d.payments.length) {
            doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text('Payments received', left, doc.y);
            doc.moveDown(0.3);
            d.payments.forEach(p => doc.font('Helvetica').fontSize(9).fillColor('#333')
                .text(`${niceDate(String(p.payment_date).slice(0, 10))}   ${p.receipt_number || ''}   ${p.method_detail || p.payment_method || ''}   ${inv.currency || 'TZS'} ${fmtMoney(p.amount_paid)}`, left, doc.y));
            doc.moveDown(0.6);
        }
        if (d.company && d.company.payment_instructions) {
            doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text('How to pay', left, doc.y);
            doc.font('Helvetica').fontSize(9).fillColor('#333').text(String(d.company.payment_instructions), left, doc.y, { width: usable });
            doc.moveDown(0.6);
        }
        if (inv.notes) { doc.font('Helvetica').fontSize(9).fillColor('#555').text('Notes: ' + inv.notes, left, doc.y, { width: usable }); }
        doc.fillColor('#999').font('Helvetica').fontSize(8).text('Thank you for your business.   |   KEY ARCH', left, doc.page.height - 60, { width: usable, align: 'center', lineBreak: false });
        doc.end();
    }
    function writeReceiptPdf(res, filename, d) {
        const PDFDocument = loadOptional('pdfkit');
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);
        const left = doc.page.margins.left, usable = doc.page.width - left - doc.page.margins.right;
        pdfHeader(doc, d.company, 'RECEIPT', d.receipt_number);
        let y = doc.y;
        const colW = usable / 2 - 8;
        pdfKV(doc, left, y, 'Received from', d.tenant_name, colW);
        pdfKV(doc, left + colW + 16, y, 'Date', niceDate(String(d.payment_date).slice(0, 10)), colW);
        doc.y = y + 44; y = doc.y;
        pdfKV(doc, left, y, 'Property / unit', `${d.property_name} - ${d.unit_number}`, colW);
        pdfKV(doc, left + colW + 16, y, 'Payment method', d.method + (d.reference ? ' (' + d.reference + ')' : ''), colW);
        doc.y = y + 44; y = doc.y;
        pdfKV(doc, left, y, 'For invoice', `${d.invoice.invoice_number}${d.invoice.description ? ' - ' + d.invoice.description : ''}`, usable);
        doc.y += 14; y = doc.y;
        doc.save().roundedRect(left, y, usable, 54, 6).fill('#EEF3FA').restore();
        doc.fillColor('#555').font('Helvetica').fontSize(9).text('AMOUNT RECEIVED', left + 14, y + 10);
        doc.fillColor('#1F3A5F').font('Helvetica-Bold').fontSize(20).text((d.currency || 'TZS') + ' ' + fmtMoney(d.amount_paid), left + 14, y + 24);
        doc.y = y + 66;
        doc.fillColor('#555').font('Helvetica').fontSize(9).text(d.amount_words || '', left, doc.y, { width: usable });
        doc.moveDown(0.8);
        y = doc.y;
        const row = (l, v, color) => { doc.fillColor('#333').font('Helvetica').fontSize(10).text(l, left, y, { width: 200 });
            doc.fillColor(color || '#111').font('Helvetica-Bold').text((d.currency || 'TZS') + ' ' + fmtMoney(v), left, y, { width: usable, align: 'right' }); y += 18; };
        row('Invoice total', d.invoice.total); row('Paid to date', d.paid_to_date, '#166534');
        row('Balance remaining', d.balance_after, d.balance_after > 0 ? '#B91C1C' : '#166534');
        if (d.extra_paid > 0) row('Extra paid (credit)', d.extra_paid);
        doc.y = y + 10;
        if (d.received_by) doc.fillColor('#555').font('Helvetica').fontSize(9).text('Received by: ' + d.received_by, left, doc.y);
        doc.fillColor('#999').font('Helvetica').fontSize(8).text('This receipt confirms the payment above.   |   KEY ARCH', left, doc.page.height - 60, { width: usable, align: 'center', lineBreak: false });
        doc.end();
    }
    function pdfFail(res, err) {
        if (!err.status) console.error('PDF error:', err);
        if (!res.headersSent) res.status(err.status || (err.code === 'MISSING_PACKAGE' ? 501 : 500)).json({ error: err.message, code: err.code }); else res.end();
    }
    app.get('/api/invoices/:id/pdf', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        if (!(await guard(req, res, 'invoice', req.params.id))) return;
        try { const d = await getInvoicePrintData(req.user.company_id, req.params.id); writeInvoicePdf(res, `${d.invoice.invoice_number}.pdf`, d); }
        catch (err) { pdfFail(res, err); }
    });
    app.get('/api/payments/:id/receipt-pdf', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        if (!(await guard(req, res, 'payment', req.params.id))) return;
        try { const d = await getReceiptData(req.user.company_id, req.params.id); writeReceiptPdf(res, `${d.receipt_number}.pdf`, d); }
        catch (err) { pdfFail(res, err); }
    });
    return { INVOICE_BALANCES_SQL, sum };
};

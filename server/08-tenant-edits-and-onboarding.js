// EDITING TENANTS AFTER SAVING: the owner/admin edits directly; staff ask for permission first
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { ALLOWED_ID_TYPES, ALLOWED_RENT_PERIODS, LEASE_MANAGERS, R_VIEW_MONEY, addPayment, allowRoles, app, authenticateToken, calculatePayment, createAuditLog, createInvoice, fmtMoney, guard, isDateStr, logLeaseEvent, niceDate, payStatusOf, periodWord, pool, scopeSql, setLeaseStatus, syncLeasePayment, todayStr, wrapAsync } = ctx;


    // EDIT TENANT (personal details + lease end date)

    // ============================================================
    // EDITING TENANTS AFTER SAVING: the owner/admin edits directly; staff ask for permission first
    // ============================================================
    const EDIT_SECTIONS = { TENANT_INFO: 'Tenant details (name, phone, ID)', LEASE_TERMS: 'Rent price, discount, periods and dates' };
    async function checkEditPermission(req, client, tenantId, section) {
        const role = req.user.role;
        if (role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN') return { ok: true };
        if (section === 'TENANT_INFO' && req.user.can_edit_tenants) return { ok: true };
        const rid = parseInt((req.body || {}).request_id);
        const deny = { ok: false, status: 403, code: 'NEEDS_APPROVAL', error: 'You need permission from the owner/admin to edit this. Ask for permission first.' };
        if (!rid) return deny;
        const r = (await client.query('SELECT * FROM edit_requests WHERE request_id = $1 AND company_id = $2 AND requested_by = $3 FOR UPDATE', [rid, req.user.company_id, req.user.user_id])).rows[0];
        if (!r || r.entity_type !== 'TENANT' || Number(r.entity_id) !== Number(tenantId) || r.section !== section) return deny;
        if (r.status !== 'APPROVED' || r.used_at || !r.expires_at || new Date(r.expires_at) < new Date()) return { ...deny, error: 'This permission has expired or was already used. Please ask again.' };
        return { ok: true, requestId: rid };
    }
    async function markRequestUsed(client, requestId) { if (requestId) await client.query("UPDATE edit_requests SET status = 'USED', used_at = NOW() WHERE request_id = $1", [requestId]); }

    app.put('/api/tenants/:id', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
        if (!(await guard(req, res, 'tenant', req.params.id))) return;
        const { full_name, nida_passport_no, identity_type, phone_number, end_date, lease_id } = req.body;
        const tenantId = req.params.id;
        if (!full_name || !phone_number || !nida_passport_no) {
            return res.status(400).json({ error: 'Name, phone and ID number are required.' });
        }
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const gate = await checkEditPermission(req, client, tenantId, 'TENANT_INFO');
            if (!gate.ok) { await client.query('ROLLBACK'); return res.status(gate.status).json({ error: gate.error, code: gate.code }); }

            const upd = await client.query(
                `UPDATE tenants SET full_name = $1, nida_passport_no = $2, phone_number = $3, identity_type = COALESCE($4, identity_type)
                 WHERE tenant_id = $5 AND company_id = $6 RETURNING tenant_id`,
                [String(full_name).trim(), String(nida_passport_no).trim(), String(phone_number).trim(),
                 ALLOWED_ID_TYPES.includes(identity_type) ? identity_type : null, tenantId, req.user.company_id]
            );
            if (upd.rows.length === 0) throw new Error('Tenant not found.');

            if (end_date && lease_id) {
                const l = (await client.query(
                    `SELECT lease_id, to_char(start_date, 'YYYY-MM-DD') AS start_str, to_char(end_date, 'YYYY-MM-DD') AS end_str
                     FROM leases WHERE lease_id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
                    [lease_id, tenantId, req.user.company_id]
                )).rows[0];
                if (!l) throw new Error('Lease not found.');
                if (end_date < l.start_str) throw new Error('End date cannot be before the start date.');
                if (end_date !== l.end_str) {
                    const days = Math.max(0, Math.round((new Date(end_date) - new Date(l.start_str)) / 86400000));
                    await client.query('UPDATE leases SET end_date = $1, duration_days = $2 WHERE lease_id = $3 AND company_id = $4', [end_date, days, lease_id, req.user.company_id]);
                    await logLeaseEvent(client, req.user.company_id, lease_id, tenantId, 'EDITED', `Lease end date changed from ${l.end_str} to ${end_date}`, null, req.user.user_id);
                }
            }
            await markRequestUsed(client, gate.requestId);
            await createAuditLog(client, req.user.company_id, req.user.user_id, 'Updated Tenant Details', 'TENANTS', req.ip, { tenant_id: tenantId, via_request: gate.requestId || null });
            await client.query('COMMIT');
            res.json({ message: 'Tenant updated successfully' });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally {
            if (client) client.release();
        }
    });

    // correct a saved contract: price, discount, periods, dates (the invoice and balances follow)
    app.put('/api/leases/:id/correct', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
        if (!(await guard(req, res, 'lease', req.params.id))) return;
        const cId = req.user.company_id, b = req.body || {};
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const lease = (await client.query(
                `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_str, to_char(end_date, 'YYYY-MM-DD') AS end_str FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE`,
                [req.params.id, cId])).rows[0];
            if (!lease) throw new Error('Contract not found.');
            const gate = await checkEditPermission(req, client, lease.tenant_id, 'LEASE_TERMS');
            if (!gate.ok) { await client.query('ROLLBACK'); return res.status(gate.status).json({ error: gate.error, code: gate.code }); }

            const calc = calculatePayment({
                rent_price: b.rent_price !== undefined && b.rent_price !== '' ? b.rent_price : lease.rent_price,
                number_of_periods: b.number_of_periods !== undefined && b.number_of_periods !== '' ? b.number_of_periods : lease.number_of_periods,
                discount: b.discount !== undefined && b.discount !== '' ? b.discount : lease.discount, paid_amount: 0
            });
            if (calc.error) throw new Error(calc.error);
            const start = b.start_date || lease.start_str, end = b.end_date || lease.end_str;
            if (!isDateStr(start) || !isDateStr(end)) throw new Error('Please enter valid dates.');
            if (end < start) throw new Error('End date cannot be before the start date.');
            const days = Math.max(0, Math.round((new Date(end) - new Date(start)) / 86400000));

            const rentInv = (await client.query("SELECT invoice_id FROM invoices WHERE lease_id = $1 AND company_id = $2 AND invoice_type = 'RENT' AND COALESCE(lease_charge, true) = true ORDER BY invoice_id ASC LIMIT 1", [lease.lease_id, cId])).rows[0];
            let others = { due: 0, sub: 0, disc: 0 };
            if (rentInv) {
                const o = (await client.query("SELECT COALESCE(SUM(amount_due),0) AS due, COALESCE(SUM(subtotal),0) AS sub, COALESCE(SUM(discount),0) AS disc FROM invoices WHERE lease_id = $1 AND company_id = $2 AND COALESCE(lease_charge, true) = true AND invoice_id <> $3", [lease.lease_id, cId, rentInv.invoice_id])).rows[0];
                others = { due: parseFloat(o.due), sub: parseFloat(o.sub), disc: parseFloat(o.disc) };
                const desc = `Rent: ${calc.periods} ${periodWord(lease.rent_period || 'Month', calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(start)} - ${niceDate(end)})`;
                await client.query('UPDATE invoices SET subtotal = $1, discount = $2, amount_due = $3, description = $4, period_start = $5, period_end = $6, issue_date = $5, due_date = $5 WHERE invoice_id = $7 AND company_id = $8',
                    [calc.totalRent, calc.discount, calc.totalToPay, desc, start, end, rentInv.invoice_id, cId]);
                const paid = parseFloat((await client.query('SELECT COALESCE(SUM(amount_paid),0) AS s FROM payments WHERE invoice_id = $1', [rentInv.invoice_id])).rows[0].s);
                await client.query('UPDATE invoices SET status = $1 WHERE invoice_id = $2', [paid >= calc.totalToPay ? 'PAID' : 'PENDING', rentInv.invoice_id]);
            }
            const toPay = calc.totalToPay + others.due;
            await client.query(
                `UPDATE leases SET start_date = $1, end_date = $2, duration_days = $3, rent_price = $4, number_of_periods = $5,
                        total_rent = $6, discount = $7, total_to_pay = $8, agreed_rent = $8 WHERE lease_id = $9 AND company_id = $10`,
                [start, end, days, calc.price, calc.periods, calc.totalRent + others.sub, calc.discount + others.disc, toPay, lease.lease_id, cId]);
            await syncLeasePayment(client, lease.lease_id, cId);
            await logLeaseEvent(client, cId, lease.lease_id, lease.tenant_id, 'EDITED',
                `Contract corrected: rent ${fmtMoney(lease.rent_price)} x ${lease.number_of_periods} -> ${fmtMoney(calc.price)} x ${calc.periods}, discount ${fmtMoney(calc.discount)}, ${lease.start_str} to ${lease.end_str} -> ${start} to ${end}`,
                toPay, req.user.user_id);
            await markRequestUsed(client, gate.requestId);
            await createAuditLog(client, cId, req.user.user_id, 'Corrected contract terms', 'TENANTS', req.ip, { lease_id: lease.lease_id, via_request: gate.requestId || null });
            await client.query('COMMIT');
            res.json({ message: 'Contract updated. The invoice and the balance were updated too.' });
        } catch (err) {
            if (client) { try { await client.query('ROLLBACK'); } catch (e) { } }
            res.status(400).json({ error: err.message });
        } finally { if (client) client.release(); }
    });

    // ---- requests for permission to edit ----
    app.post('/api/edit-requests', authenticateToken, allowRoles('PROPERTY_MANAGER', 'ACCOUNTANT'), wrapAsync(async (req, res) => {
        const cId = req.user.company_id, b = req.body || {};
        const tenantId = parseInt(b.tenant_id), section = String(b.section || '');
        if (!(await guard(req, res, 'tenant', tenantId))) return;
        if (!EDIT_SECTIONS[section]) return res.status(400).json({ error: 'Please choose what you want to edit.' });
        const reason = String(b.reason || '').trim().slice(0, 500);
        if (reason.length < 3) return res.status(400).json({ error: 'Please write what was wrong (the reason).' });
        const t = (await pool.query(
            `SELECT t.full_name, (SELECT COALESCE(p.property_name, p.title) || ' (' || u.unit_number || ')' FROM leases l JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                                  WHERE l.tenant_id = t.tenant_id ORDER BY (l.lease_state = 'CURRENT') DESC, l.lease_id DESC LIMIT 1) AS place
             FROM tenants t WHERE t.tenant_id = $1 AND t.company_id = $2`, [tenantId, cId])).rows[0];
        if (!t) return res.status(404).json({ error: 'Tenant not found.' });
        const dup = (await pool.query("SELECT request_id FROM edit_requests WHERE company_id = $1 AND entity_type = 'TENANT' AND entity_id = $2 AND section = $3 AND requested_by = $4 AND status = 'PENDING'", [cId, tenantId, section, req.user.user_id])).rows[0];
        if (dup) return res.status(400).json({ error: 'You already asked for this. Wait for the owner/admin to answer.' });
        const label = (t.full_name + (t.place ? ' · ' + t.place : '')).slice(0, 200);
        const r = await pool.query("INSERT INTO edit_requests (company_id, entity_type, entity_id, entity_label, section, reason, requested_by) VALUES ($1, 'TENANT', $2, $3, $4, $5, $6) RETURNING request_id", [cId, tenantId, label, section, reason, req.user.user_id]);
        await createAuditLog(pool, cId, req.user.user_id, 'Asked permission to edit', 'TENANTS', req.ip, { tenant_id: tenantId, section });
        res.status(201).json({ message: 'Request sent. The owner/admin will see it.', request_id: r.rows[0].request_id });
    }));

    app.get('/api/edit-requests', authenticateToken, allowRoles('COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), wrapAsync(async (req, res) => {
        const isAdmin = req.user.role === 'COMPANY_ADMIN';
        const params = [req.user.company_id]; let where = 'e.company_id = $1';
        if (!isAdmin) { params.push(req.user.user_id); where += ' AND e.requested_by = $2'; }
        const rows = (await pool.query(
            `SELECT e.*, u.full_name AS requested_by_name, d.full_name AS decided_by_name,
                    (e.status = 'APPROVED' AND e.used_at IS NULL AND e.expires_at > NOW()) AS usable
             FROM edit_requests e LEFT JOIN users u ON e.requested_by = u.user_id LEFT JOIN users d ON e.decided_by = d.user_id
             WHERE ${where} ORDER BY (e.status = 'PENDING') DESC, e.created_at DESC LIMIT 200`, params)).rows;
        res.json({ requests: rows.map(r => ({ ...r, section_label: EDIT_SECTIONS[r.section] || r.section })) });
    }));

    app.get('/api/edit-requests/summary', authenticateToken, wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        if (req.user.role === 'COMPANY_ADMIN') {
            const r = (await pool.query("SELECT COUNT(*) AS n FROM edit_requests WHERE company_id = $1 AND status = 'PENDING'", [cId])).rows[0];
            return res.json({ count: parseInt(r.n) });
        }
        if (['PROPERTY_MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
            const r = (await pool.query("SELECT COUNT(*) AS n FROM edit_requests WHERE company_id = $1 AND requested_by = $2 AND status = 'APPROVED' AND used_at IS NULL AND expires_at > NOW()", [cId, req.user.user_id])).rows[0];
            return res.json({ count: parseInt(r.n) });
        }
        res.json({ count: 0 });
    }));

    app.put('/api/edit-requests/:id/decision', authenticateToken, allowRoles('COMPANY_ADMIN'), wrapAsync(async (req, res) => {
        const b = req.body || {}; const approve = b.approve === true || b.approve === 'true';
        const r = (await pool.query("SELECT * FROM edit_requests WHERE request_id = $1 AND company_id = $2", [req.params.id, req.user.company_id])).rows[0];
        if (!r) return res.status(404).json({ error: 'Request not found.' });
        if (r.status !== 'PENDING') return res.status(400).json({ error: 'This request was already answered.' });
        await pool.query(
            `UPDATE edit_requests SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3, expires_at = ${approve ? "NOW() + interval '24 hours'" : 'NULL'} WHERE request_id = $4`,
            [approve ? 'APPROVED' : 'REJECTED', req.user.user_id, String(b.note || '').slice(0, 300) || null, r.request_id]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, approve ? 'Allowed an edit' : 'Refused an edit', 'TENANTS', req.ip, { request_id: r.request_id });
        res.json({ message: approve ? 'Allowed. The staff member can edit for the next 24 hours (one time).' : 'Refused.' });
    }));

    app.put('/api/edit-requests/:id/cancel', authenticateToken, allowRoles('PROPERTY_MANAGER', 'ACCOUNTANT'), wrapAsync(async (req, res) => {
        const r = await pool.query("UPDATE edit_requests SET status = 'CANCELLED' WHERE request_id = $1 AND company_id = $2 AND requested_by = $3 AND status IN ('PENDING','APPROVED') RETURNING request_id", [req.params.id, req.user.company_id, req.user.user_id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Request not found.' });
        res.json({ message: 'Cancelled.' });
    }));

    // RENEW CONTRACT: a NEW lease record for the same tenant and unit
    app.post('/api/leases/:id/renew', authenticateToken, allowRoles(...LEASE_MANAGERS), async (req, res) => {
        if (!(await guard(req, res, 'lease', req.params.id))) return;
        const { start_date, end_date, rent_price, number_of_periods, discount, paid_amount } = req.body;
        const rent_period = req.body.rent_period || 'Month';
        const companyId = req.user.company_id;

        if (!start_date) return res.status(400).json({ error: 'New lease start date is required.' });
        if (!ALLOWED_RENT_PERIODS.includes(rent_period)) return res.status(400).json({ error: 'Invalid rent period.' });
        if (end_date && end_date < start_date) return res.status(400).json({ error: 'End date cannot be before the start date.' });

        const calc = calculatePayment({ rent_price, number_of_periods, discount, paid_amount });
        if (calc.error) return res.status(400).json({ error: calc.error });

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const old = (await client.query('SELECT * FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId])).rows[0];
            if (!old) throw new Error('Lease not found.');
            if (old.lease_state !== 'CURRENT') throw new Error('Only a current lease can be renewed.');

            const newEnd = end_date || new Date(new Date(start_date).setFullYear(new Date(start_date).getFullYear() + 1)).toISOString().split('T')[0];
            const durationDays = Math.max(0, Math.round((new Date(newEnd) - new Date(start_date)) / 86400000));

            await client.query("UPDATE leases SET lease_state = 'RENEWED', ended_at = NOW(), ended_reason = 'Renewed' WHERE lease_id = $1 AND company_id = $2", [old.lease_id, companyId]);
            await setLeaseStatus(client, old.lease_id, companyId, 'EXPIRED');

            const leaseRes = await client.query(
                `INSERT INTO leases
                 (company_id, unit_id, tenant_id, property_id, start_date, end_date, duration_days, agreed_rent, amount_paid, amount_due, payment_cycle, status,
                  rent_price, rent_period, number_of_periods, total_rent, discount, total_to_pay, payment_status, previous_lease_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
                [
                    companyId, old.unit_id, old.tenant_id, old.property_id, start_date, newEnd, durationDays, calc.totalToPay, calc.paid, calc.amountDue, 'MONTHLY', 'ACTIVE',
                    calc.price, rent_period, calc.periods, calc.totalRent, calc.discount, calc.totalToPay, calc.status, old.lease_id
                ]
            );
            const lease = leaseRes.rows[0];
            if (old.currency && old.currency !== 'TZS') await client.query('UPDATE leases SET currency = $1 WHERE lease_id = $2', [old.currency, lease.lease_id]);
            await client.query('UPDATE leases SET service_amount = $1, service_rate = $2 WHERE lease_id = $3', [old.service_amount, old.service_rate, lease.lease_id]);

            const invoice = await createInvoice(client, {
                companyId, leaseId: lease.lease_id, type: 'RENT', subtotal: calc.totalRent, discount: calc.discount,
                description: `Rent (renewal): ${calc.periods} ${periodWord(rent_period, calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(start_date)} - ${niceDate(newEnd)})`,
                issueDate: start_date <= todayStr() ? start_date : todayStr(), dueDate: start_date, periodStart: start_date, periodEnd: newEnd, leaseCharge: true, userId: req.user.user_id,
                status: calc.amountDue === 0 ? 'PAID' : 'PENDING'
            });

            if (calc.paid > 0) {
                await addPayment(client, {
                    companyId, invoiceId: invoice.invoice_id, amount: calc.paid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                    reference: req.body.payment_reference, date: todayStr(), userId: req.user.user_id
                });
            }

            await logLeaseEvent(client, companyId, lease.lease_id, old.tenant_id, 'RENEWED',
                `Contract renewed: ${start_date} to ${newEnd} (${calc.periods} ${rent_period}${calc.periods === 1 ? '' : 's'})`, calc.totalToPay, req.user.user_id);
            await createAuditLog(client, companyId, req.user.user_id, 'Renewed Lease', 'LEASES', req.ip, { old_lease_id: old.lease_id, new_lease_id: lease.lease_id });
            await client.query('COMMIT');
            res.status(201).json({ message: 'Contract renewed.', lease, invoice });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally {
            if (client) client.release();
        }
    });

    // EXTEND STAY: same lease, later end date, extra charge as its own invoice
    app.post('/api/leases/:id/extend', authenticateToken, allowRoles(...LEASE_MANAGERS), async (req, res) => {
        if (!(await guard(req, res, 'lease', req.params.id))) return;
        const { new_end_date, extra_periods, rent_price, discount, paid_amount } = req.body;
        const companyId = req.user.company_id;
        if (!new_end_date) return res.status(400).json({ error: 'New end date is required.' });

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const lease = (await client.query(
                `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_str, to_char(end_date, 'YYYY-MM-DD') AS end_str
                 FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE`,
                [req.params.id, companyId]
            )).rows[0];
            if (!lease) throw new Error('Lease not found.');
            if (lease.lease_state !== 'CURRENT') throw new Error('Only a current lease can be extended.');
            if (new_end_date <= lease.end_str) throw new Error(`New end date must be after the current end date (${lease.end_str}).`);

            const period = lease.rent_period || 'Month';
            const calc = calculatePayment({
                rent_price: rent_price !== undefined && rent_price !== '' ? rent_price : lease.rent_price,
                number_of_periods: extra_periods, discount, paid_amount
            });
            if (calc.error) throw new Error(calc.error);

            const oldToPay = parseFloat(lease.total_to_pay ?? lease.agreed_rent ?? 0);
            const newToPay = oldToPay + calc.totalToPay;
            const newPaid = parseFloat(lease.amount_paid || 0) + calc.paid;
            const newDue = Math.max(0, Math.round((newToPay - newPaid) * 100) / 100);
            const durationDays = Math.max(0, Math.round((new Date(new_end_date) - new Date(lease.start_str)) / 86400000));

            await client.query(
                `UPDATE leases SET end_date = $1, duration_days = $2,
                    number_of_periods = COALESCE(number_of_periods, 0) + $3,
                    total_rent = COALESCE(total_rent, 0) + $4,
                    discount = COALESCE(discount, 0) + $5,
                    total_to_pay = $6, agreed_rent = $6,
                    amount_paid = $7, amount_due = $8, payment_status = $9
                 WHERE lease_id = $10 AND company_id = $11`,
                [new_end_date, durationDays, calc.periods, calc.totalRent, calc.discount, newToPay, newPaid, newDue, payStatusOf(newToPay, newPaid), lease.lease_id, companyId]
            );

            const invoice = await createInvoice(client, {
                companyId, leaseId: lease.lease_id, type: 'EXTENSION', subtotal: calc.totalRent, discount: calc.discount,
                description: `Extra stay: ${calc.periods} ${periodWord(period, calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(lease.end_str)} - ${niceDate(new_end_date)})`,
                issueDate: todayStr(), dueDate: todayStr(), periodStart: lease.end_str, periodEnd: new_end_date, leaseCharge: true, userId: req.user.user_id,
                status: calc.amountDue === 0 ? 'PAID' : 'PENDING'
            });

            if (calc.paid > 0) {
                await addPayment(client, {
                    companyId, invoiceId: invoice.invoice_id, amount: calc.paid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                    reference: req.body.payment_reference, date: todayStr(), userId: req.user.user_id
                });
            }

            await logLeaseEvent(client, companyId, lease.lease_id, lease.tenant_id, 'EXTENDED',
                `Stay extended from ${lease.end_str} to ${new_end_date} (+${calc.periods} ${period}${calc.periods === 1 ? '' : 's'})`, calc.totalToPay, req.user.user_id);
            await createAuditLog(client, companyId, req.user.user_id, 'Extended Lease', 'LEASES', req.ip, { lease_id: lease.lease_id, new_end_date });
            await client.query('COMMIT');
            res.status(201).json({ message: 'Stay extended.', invoice });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally {
            if (client) client.release();
        }
    });

    // MOVE OUT: ends the lease, frees the unit, keeps the history and any unpaid balance
    app.post('/api/leases/:id/end', authenticateToken, allowRoles(...LEASE_MANAGERS), async (req, res) => {
        if (!(await guard(req, res, 'lease', req.params.id))) return;
        const companyId = req.user.company_id;
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const lease = (await client.query('SELECT * FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId])).rows[0];
            if (!lease) throw new Error('Lease not found.');
            if (lease.lease_state !== 'CURRENT') throw new Error('This lease has already ended.');

            await client.query(
                "UPDATE leases SET lease_state = 'ENDED', ended_at = NOW(), ended_reason = $1 WHERE lease_id = $2 AND company_id = $3",
                [String(req.body.reason || 'Moved out').slice(0, 200), lease.lease_id, companyId]
            );
            await client.query("UPDATE units SET status = 'VACANT' WHERE unit_id = $1 AND company_id = $2", [lease.unit_id, companyId]);
            await setLeaseStatus(client, lease.lease_id, companyId, 'TERMINATED');
            await client.query(
                `UPDATE tenants SET is_active = EXISTS (SELECT 1 FROM leases WHERE tenant_id = $1 AND company_id = $2 AND lease_state = 'CURRENT')
                 WHERE tenant_id = $1 AND company_id = $2`,
                [lease.tenant_id, companyId]
            );

            const owed = (await client.query(
                `SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0) AS owed
                 FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id WHERE l.tenant_id = $1 AND inv.company_id = $2`,
                [lease.tenant_id, companyId]
            )).rows[0].owed;

            await logLeaseEvent(client, companyId, lease.lease_id, lease.tenant_id, 'MOVED_OUT', `Moved out. Unpaid balance: ${parseFloat(owed).toLocaleString('en-US')}`, parseFloat(owed), req.user.user_id);
            await createAuditLog(client, companyId, req.user.user_id, 'Ended Lease (Move Out)', 'LEASES', req.ip, { lease_id: lease.lease_id });
            await client.query('COMMIT');
            res.json({ message: 'Tenant moved out. The unit is now vacant.', balance_owed: parseFloat(owed) });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally {
            if (client) client.release();
        }
    });

    // DELETE a tenant that was entered by mistake (only if no payment was ever recorded)
    // DASHBOARD METRICS
    app.get('/api/dashboard/metrics', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
        const cId = req.user.company_id;
        try {
            const ps = [cId], us = [cId], ls = [cId];
            const sP = scopeSql(req, 'property_id', ps), sU = scopeSql(req, 'property_id', us), sL = scopeSql(req, 'property_id', ls);
            const totalProperties = await pool.query(`SELECT COUNT(*) FROM properties WHERE company_id = $1 ${sP}`, ps);
            const totalUnits = await pool.query(`SELECT COUNT(*) FROM units WHERE company_id = $1 ${sU}`, us);
            const occupiedUnits = await pool.query(`SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'OCCUPIED' ${sU}`, us);
            const vacantUnits = await pool.query(`SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'VACANT' ${sU}`, us);
            const activeTenants = await pool.query(`SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE company_id = $1 AND lease_state = 'CURRENT' ${sL}`, ls);

            const unitsTotal = parseInt(totalUnits.rows[0]?.count || 0);
            const unitsOccupied = parseInt(occupiedUnits.rows[0]?.count || 0);

            res.json({
                totalProperties: parseInt(totalProperties.rows[0]?.count || 0),
                totalUnits: unitsTotal,
                occupiedUnits: unitsOccupied,
                vacantUnits: parseInt(vacantUnits.rows[0]?.count || 0),
                occupancyRate: unitsTotal > 0 ? Math.round((unitsOccupied / unitsTotal) * 100) : 0,
                activeTenants: parseInt(activeTenants.rows[0]?.count || 0)
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    return {};
};

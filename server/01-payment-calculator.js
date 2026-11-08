// PAYMENT CALCULATOR (the server is the only source of truth)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {


    // ============================================================
    // PAYMENT CALCULATOR (the server is the only source of truth)
    // Total Rent  = Rent Price x Number of periods
    // Total To Pay = Total Rent - Discount
    // Balance      = Total To Pay - Amount Paid
    //   Balance > 0  -> tenant still owes   (UNPAID / PARTIAL)
    //   Balance = 0  -> fully paid          (PAID)
    //   Balance < 0  -> tenant paid extra   (EXTRA_PAID)
    // ============================================================
    const ALLOWED_RENT_PERIODS = ['Day', 'Week', 'Month', 'Year'];
    const ALLOWED_ID_TYPES = ['NIDA', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID'];

    function calculatePayment({ rent_price, number_of_periods, discount, paid_amount }) {
        const price = parseFloat(rent_price);
        const periods = parseFloat(number_of_periods);
        const disc = parseFloat(discount || 0);
        const paid = parseFloat(paid_amount || 0);

        if (!(price > 0)) return { error: 'Rent Price must be greater than 0.' };
        if (!(periods > 0)) return { error: 'Number of periods must be greater than 0.' };
        if (isNaN(disc) || disc < 0) return { error: 'Discount must be 0 or more.' };
        if (isNaN(paid) || paid < 0) return { error: 'Amount Paid must be 0 or more.' };

        const totalRent = Math.round(price * periods);
        if (disc > totalRent) return { error: 'Discount cannot be more than the Total Rent.' };

        const totalToPay = totalRent - disc;
        const balance = Math.round((totalToPay - paid) * 100) / 100;

        let status;
        if (balance < 0) status = 'EXTRA_PAID';
        else if (balance === 0) status = 'PAID';
        else if (paid > 0) status = 'PARTIAL';
        else status = 'UNPAID';

        return {
            price,
            periods,
            discount: disc,
            paid,
            totalRent,
            totalToPay,
            amountDue: Math.max(0, balance),
            extraPaid: Math.max(0, -balance),
            status
        };
    }


    // Writes a line in the tenant history (renewals, extensions, move-outs...).
    // Uses a savepoint so a problem here can never break the main action.
    async function logLeaseEvent(client, companyId, leaseId, tenantId, type, description, amount, userId) {
        try {
            await client.query('SAVEPOINT lease_event');
            await client.query(
                'INSERT INTO lease_events (company_id, lease_id, tenant_id, event_type, description, amount, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [companyId, leaseId, tenantId, type, description, amount || null, userId || null]
            );
            await client.query('RELEASE SAVEPOINT lease_event');
        } catch (err) {
            console.error('Lease event warning:', err.message);
            try { await client.query('ROLLBACK TO SAVEPOINT lease_event'); } catch (e) { /* ignore */ }
        }
    }

    // The payments table only accepts CASH / MOBILE_MONEY / BANK_TRANSFER / CHEQUE
    function normalizePaymentMethod(m) {
        const t = String(m || '').toLowerCase();
        if (t.includes('mobile') || t.includes('mpesa') || t.includes('m-pesa')) return 'MOBILE_MONEY';
        if (t.includes('bank') || t.includes('transfer')) return 'BANK_TRANSFER';
        if (t.includes('cheque') || t.includes('check')) return 'CHEQUE';
        return 'CASH';
    }

    // Keeps the old "status" column (ACTIVE / EXPIRED / TERMINATED) in step with lease_state.
    // Safe: if the database refuses the value, the main action still goes ahead.
    async function setLeaseStatus(client, leaseId, companyId, status) {
        try {
            await client.query('SAVEPOINT lease_status');
            await client.query('UPDATE leases SET status = $1 WHERE lease_id = $2 AND company_id = $3', [status, leaseId, companyId]);
            await client.query('RELEASE SAVEPOINT lease_status');
        } catch (err) {
            console.error('Lease status warning:', err.message);
            try { await client.query('ROLLBACK TO SAVEPOINT lease_status'); } catch (e) { /* ignore */ }
        }
    }

    function payStatusOf(toPay, paid) {
        const balance = Math.round((toPay - paid) * 100) / 100;
        if (balance < 0) return 'EXTRA_PAID';
        if (balance === 0) return 'PAID';
        return paid > 0 ? 'PARTIAL' : 'UNPAID';
    }
    return { ALLOWED_ID_TYPES, ALLOWED_RENT_PERIODS, calculatePayment, logLeaseEvent, normalizePaymentMethod, payStatusOf, setLeaseStatus };
};

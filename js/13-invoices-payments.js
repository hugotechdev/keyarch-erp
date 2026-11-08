// ============================================================
// INVOICES, PAYMENTS, RECEIPTS
// ============================================================
const TYPE_LABEL = { RENT: 'Rent', SERVICE: 'Service charge', EXTENSION: 'Extension', DEPOSIT: 'Deposit', UTILITY: 'Utility', PENALTY: 'Penalty', REPAIR: 'Repair', OTHER: 'Other' };
let invTab = 'invoices', receiptsData = [], lastPreviewInvoice = null;

function setInvTab(t) {
    invTab = t;
    document.getElementById('inv-tab-invoices').classList.toggle('hidden', t !== 'invoices');
    document.getElementById('inv-tab-receipts').classList.toggle('hidden', t !== 'receipts');
    document.querySelectorAll('.itab-btn').forEach(b => {
        const on = b.dataset.itab === t;
        b.className = 'itab-btn px-4 py-2 rounded-xl font-bold border ' + (on ? 'bg-blue-600 text-white border-blue-500' : 'bg-[#14223d] text-gray-400 border-[#233863]');
    });
    if (t === 'receipts') loadReceipts();
}

function invStatus(i) { const b = Number(i.balance); return b <= 0 ? 'PAID' : (Number(i.paid) > 0 ? 'PARTIAL' : 'UNPAID'); }

function renderInvoicesTable() {
    const tbody = document.getElementById('table-invoices-body'); if (!tbody) return;
    const q = (document.getElementById('inv-search')?.value || '').toLowerCase().trim();
    const ft = document.getElementById('inv-filter-type')?.value || '', fs = document.getElementById('inv-filter-status')?.value || '';
    const rows = currentInvoices.filter(i => (!ft || (i.invoice_type || 'RENT') === ft) && (!fs || invStatus(i) === fs) &&
        (!q || [i.invoice_number, i.tenant_name, i.unit_number, i.property_name, i.description].some(v => String(v || '').toLowerCase().includes(q))));
    if (rows.length === 0) { tbody.innerHTML = '<tr><td colspan="9" class="p-4 text-center text-gray-500">No invoices found.</td></tr>'; return; }
    tbody.innerHTML = rows.map(i => {
        const balance = Number(i.balance), status = invStatus(i);
        const cls = status === 'PAID' ? 'bg-emerald-900/40 text-emerald-300 border-emerald-500/30' : status === 'PARTIAL' ? 'bg-amber-900/40 text-amber-300 border-amber-500/30' : 'bg-rose-900/40 text-rose-300 border-rose-500/30';
        const late = balance > 0 && Number(i.days_left) < 0;
        return `
        <tr class="hover:bg-[#14223d]/50">
            <td class="p-3 font-mono font-bold text-purple-400 whitespace-nowrap">${esc(i.invoice_number)}<div class="text-[10px] text-gray-500 font-normal">${fmtDate(i.issue_date)}</div></td>
            <td class="p-3 font-bold text-white">${esc(i.tenant_name)}<div class="text-[10px] text-gray-500 font-normal">${esc(i.property_name)} (${esc(i.unit_number)})</div></td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-[#14223d] border border-[#233863]">${esc(TYPE_LABEL[i.invoice_type || 'RENT'] || i.invoice_type)}</span></td>
            <td class="p-3 font-bold text-gray-200">${money(i.amount_due, i.currency)}</td>
            <td class="p-3 font-bold text-emerald-400">${money(i.paid, i.currency)}</td>
            <td class="p-3 font-bold ${balance > 0 ? 'text-rose-400' : 'text-gray-400'}">${balance > 0 ? money(balance, i.currency) : (balance < 0 ? 'Extra ' + money(-balance, i.currency) : '-')}</td>
            <td class="p-3 ${late ? 'text-rose-300' : 'text-gray-400'} whitespace-nowrap">${fmtDate(i.due_date)}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] border ${cls}">${status}</span></td>
            <td class="p-3 whitespace-nowrap">
                ${balance > 0 && canMoney() ? `<button onclick="openPaymentModal(${Number(i.invoice_id)})" class="px-2.5 py-1 mr-1 bg-emerald-600/30 text-emerald-300 border border-emerald-500/50 rounded font-bold hover:bg-emerald-600 hover:text-white">Pay</button>` : ''}
                <button onclick="showInvoiceModal(${Number(i.invoice_id)})" title="View / print" class="px-2.5 py-1 bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 rounded font-bold hover:bg-cyan-600 hover:text-white"><i class="fa-solid fa-print"></i></button>
                ${balance > 0 ? contactBtns(i.tenant_phone, remindText(i.tenant_name, balance, companyName()), true) : ''}
            </td>
        </tr>`;
    }).join('');
}

// ---- issue invoice ----
function openInvoiceModal(leaseId) {
    const sel = document.getElementById('inv-lease-id');
    const cur = currentTenantsList.filter(t => t.lease_state === 'CURRENT');
    sel.innerHTML = cur.length === 0 ? '<option value="">No tenants with a current contract</option>' :
        cur.map(t => `<option value="${esc(t.lease_id)}" data-svc="${esc(t.service_charge || 0)}" data-incl="${t.service_inclusive ? 1 : 0}">${esc(t.full_name)} - ${esc(t.property_name)} (${esc(t.unit_number)})</option>`).join('');
    if (leaseId) sel.value = String(leaseId);
    document.getElementById('inv-type').value = 'SERVICE';
    ['inv-desc', 'inv-amount', 'inv-discount', 'inv-pfrom', 'inv-pto', 'inv-notes'].forEach(i => document.getElementById(i).value = '');
    document.getElementById('inv-issue').value = todayISO();
    const d = new Date(); d.setDate(d.getDate() + 7); document.getElementById('inv-due').value = toDateInput(d);
    sel.onchange = onInvType; onInvType(); calcInvoiceForm();
    openModal('modal-invoice');
}
function onInvType() {
    const t = document.getElementById('inv-type').value;
    const ph = { SERVICE: 'e.g. Taka - November 2026', UTILITY: 'e.g. Water bill - October', DEPOSIT: 'e.g. Security deposit', PENALTY: 'e.g. Late payment fee', REPAIR: 'e.g. Broken window', RENT: 'e.g. Rent for December', OTHER: 'What is this invoice for? *' };
    document.getElementById('inv-desc').placeholder = ph[t] || '';
    document.getElementById('inv-desc-label').innerText = t === 'OTHER' ? 'Description *' : 'Description';
    if (t === 'SERVICE') {
        const o = document.getElementById('inv-lease-id').selectedOptions[0];
        if (o && Number(o.dataset.svc) > 0 && !document.getElementById('inv-amount').value) document.getElementById('inv-amount').value = formatMoney(o.dataset.svc);
        calcInvoiceForm();
    }
}
function calcInvoiceForm() {
    const a = parseMoney(document.getElementById('inv-amount').value), d = parseMoney(document.getElementById('inv-discount').value);
    setText('inv-total-preview', money(Math.max(0, a - d)));
}
async function submitInvoice(e) {
    e.preventDefault();
    const lease = document.getElementById('inv-lease-id').value;
    if (!lease) return alert('Choose a tenant.');
    const r = await api('/api/invoices/issue', 'POST', {
        lease_id: parseInt(lease), invoice_type: document.getElementById('inv-type').value, description: document.getElementById('inv-desc').value,
        amount: parseMoney(document.getElementById('inv-amount').value), discount: parseMoney(document.getElementById('inv-discount').value),
        issue_date: document.getElementById('inv-issue').value || undefined, due_date: document.getElementById('inv-due').value,
        period_start: document.getElementById('inv-pfrom').value || undefined, period_end: document.getElementById('inv-pto').value || undefined,
        notes: document.getElementById('inv-notes').value
    });
    if (!r.ok) return alert(r.data.error || 'Failed');
    closeModal('modal-invoice'); loadAllData(); showInvoiceModal(r.data.invoice_id);
}

// ---- printable invoice ----
function companyHeader(c) {
    c = c || {};
    const logo = c.logo_data ? `<img src="${esc(c.logo_data)}" alt="" class="ka-logo w-16 h-16 shrink-0" style="background:transparent">` : '';
    return `<div class="flex items-start gap-3">${logo}<div><h2 class="text-2xl font-black text-slate-900 tracking-tight">${esc(c.company_name || '')}</h2>
        <div class="text-[11px] text-slate-500 mt-1 leading-relaxed">${[c.address, c.phone, c.email].filter(Boolean).map(esc).join(' · ')}${c.tin ? `<br>TIN: ${esc(c.tin)}` : ''}</div></div></div>`;
}
async function showInvoiceModal(invoiceId) {
    const r = await api(`/api/invoices/${invoiceId}/print`);
    if (!r.ok) return alert('Error loading invoice: ' + (r.data.error || 'Server error'));
    const d = r.data, inv = d.invoice, t = d.tenant;
    const moneyC = n => money(n, inv.currency);
    lastPreviewInvoice = inv; lastInvoiceData = d;
    const idLabels = { NIDA: 'NIDA', PASSPORT: 'Passport', DRIVING_LICENSE: 'Driving License', VOTER_ID: 'Voter ID' };
    const st = inv.balance <= 0 ? 'PAID' : (inv.paid > 0 ? 'PARTIAL' : 'UNPAID');
    const stCls = st === 'PAID' ? 'bg-emerald-100 text-emerald-800' : st === 'PARTIAL' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800';
    const idTxt = t.id_number ? `${idLabels[t.id_type] || 'ID'}: ${esc(t.id_number)}` : '';
    const pays = d.payments.length ? `
        <div><p class="font-bold text-slate-400 uppercase tracking-wider text-[11px] mb-1">Payments received</p>
        <table class="w-full text-xs"><tbody class="divide-y divide-slate-100">${d.payments.map(p => `<tr><td class="py-1.5">${fmtDate(p.payment_date)}</td><td class="py-1.5 text-slate-500">${esc(p.receipt_number || '')}</td><td class="py-1.5 text-slate-500">${esc(p.method_detail || p.payment_method || '')}${p.reference_no ? ' · ' + esc(p.reference_no) : ''}</td><td class="py-1.5 text-right font-semibold">${moneyC(p.amount_paid)}</td></tr>`).join('')}</tbody></table></div>` : '';
    document.getElementById('invoice-printable-area').innerHTML = `
        <div class="space-y-6">
        <div class="flex justify-between items-start border-b pb-5 gap-4">
            ${companyHeader(d.company)}
            <div class="text-right shrink-0">
                <div class="text-xl font-black text-slate-800 tracking-wide">INVOICE</div>
                <span class="inline-block px-3 py-1 rounded-full text-[11px] font-extrabold uppercase ${stCls}">${st}</span>
                <p class="text-sm font-bold text-slate-700 mt-2">${esc(inv.invoice_number)}</p>
                <p class="text-xs text-slate-500">Date: ${fmtDate(inv.issue_date)}</p>
                <p class="text-xs text-slate-500">Due: <b>${fmtDate(inv.due_date)}</b></p>
            </div>
        </div>
        <div class="grid grid-cols-2 gap-6 text-xs">
            <div><p class="font-bold text-slate-400 uppercase tracking-wider mb-1">Billed to</p>
                <p class="font-extrabold text-slate-900 text-sm">${esc(t.name)}</p><p class="text-slate-600">${esc(t.phone || '')}</p><p class="text-slate-600">${idTxt}</p></div>
            <div><p class="font-bold text-slate-400 uppercase tracking-wider mb-1">Property</p>
                <p class="font-extrabold text-slate-900 text-sm">${esc(d.property_name)}</p><p class="text-slate-600">Unit: ${esc(d.unit_number)}</p><p class="text-slate-600">${esc(d.property_address || '')}</p></div>
        </div>
        <div class="text-xs"><span class="px-2 py-0.5 rounded bg-slate-100 font-bold text-slate-600">${esc(TYPE_LABEL[inv.invoice_type] || inv.invoice_type)}</span>
            ${inv.period_start ? `<span class="ml-2 text-slate-500">Period: ${fmtDate(inv.period_start)}${inv.period_end ? ' - ' + fmtDate(inv.period_end) : ''}</span>` : ''}</div>
        <table class="w-full text-left text-xs border-collapse">
            <thead><tr class="bg-slate-100 border-y border-slate-200 text-slate-700 uppercase font-bold"><th class="py-2.5 px-3">Description</th><th class="py-2.5 px-3 text-right">Amount (TZS)</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
                <tr><td class="py-3 px-3 font-semibold">${esc(inv.description)}</td><td class="py-3 px-3 text-right font-bold">${fmtN(inv.subtotal)}</td></tr>
                ${inv.discount > 0 ? `<tr><td class="py-2 px-3 text-amber-700">Discount</td><td class="py-2 px-3 text-right text-amber-700">- ${fmtN(inv.discount)}</td></tr>` : ''}
                <tr class="bg-slate-50"><td class="py-2.5 px-3 font-extrabold">Total</td><td class="py-2.5 px-3 text-right font-extrabold">${fmtN(inv.total)}</td></tr>
                <tr><td class="py-2 px-3 text-emerald-700">Amount paid</td><td class="py-2 px-3 text-right text-emerald-700">${fmtN(inv.paid)}</td></tr>
                <tr class="${inv.balance > 0 ? 'bg-rose-50' : 'bg-emerald-50'}"><td class="py-2.5 px-3 font-extrabold">${inv.balance > 0 ? 'Balance due' : (inv.balance < 0 ? 'Extra paid (credit)' : 'Balance')}</td>
                    <td class="py-2.5 px-3 text-right font-extrabold ${inv.balance > 0 ? 'text-rose-700' : 'text-emerald-700'}">${fmtN(Math.abs(inv.balance))}</td></tr>
            </tbody>
        </table>
        ${pays}
        ${inv.notes ? `<div class="text-xs"><p class="font-bold text-slate-400 uppercase tracking-wider mb-1">Notes</p><p class="text-slate-700 whitespace-pre-line">${esc(inv.notes)}</p></div>` : ''}
        ${d.company && d.company.payment_instructions && inv.balance > 0 ? `<div class="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3"><p class="font-bold text-slate-500 uppercase tracking-wider mb-1">How to pay</p><p class="text-slate-700 whitespace-pre-line">${esc(d.company.payment_instructions)}</p></div>` : ''}
        <div class="border-t pt-3 flex justify-between text-[11px] text-slate-400"><span>Thank you for your business.</span><span>Generated by KEY ARCH</span></div>
        </div>`;
    document.getElementById('ip-pay-btn').classList.toggle('hidden', !(inv.balance > 0 && canMoney()));
    openModal('modal-invoice-print');
}
function payFromPreview() { if (!lastPreviewInvoice) return; closeModal('modal-invoice-print'); openPaymentModal(lastPreviewInvoice.invoice_id); }

// ---- record payment ----
function openPaymentModal(invoiceId) {
    const unpaid = currentInvoices.filter(i => Number(i.balance) > 0);
    const select = document.getElementById('pay-invoice-id');
    select.innerHTML = unpaid.length === 0 ? '<option value="">No unpaid invoices</option>'
        : unpaid.map(i => `<option value="${esc(i.invoice_id)}">${esc(i.invoice_number)} · ${esc(i.tenant_name)} · ${esc(TYPE_LABEL[i.invoice_type || 'RENT'] || '')} (owes ${money(i.balance, i.currency)})</option>`).join('');
    if (invoiceId) select.value = String(invoiceId);
    document.getElementById('pay-amount').value = ''; document.getElementById('pay-ref').value = ''; document.getElementById('pay-notes').value = '';
    const pd = document.getElementById('pay-date'); pd.value = todayISO(); pd.max = todayISO();
    updatePaymentHint(true); closeModal('modal-list'); closeModal('modal-invoice-print'); openModal('modal-payment');
    if (!finAccounts.length) loadFinAccounts().then(() => updatePaymentHint(false));
}
function updatePaymentHint(prefill) {
    const id = document.getElementById('pay-invoice-id').value;
    const inv = currentInvoices.find(i => String(i.invoice_id) === id);
    const hint = document.getElementById('pay-hint');
    if (!inv) { hint.innerText = 'There are no unpaid invoices.'; return; }
    hint.innerHTML = `${esc(inv.tenant_name)} · ${esc(inv.property_name)} (${esc(inv.unit_number)})<br>Total ${money(inv.amount_due, inv.currency)} · Paid ${money(inv.paid, inv.currency)} · <b class="text-rose-400">Balance ${money(inv.balance, inv.currency)}</b>`;
    if (prefill) document.getElementById('pay-recv-cur').value = inv.currency === 'USD' ? 'USD' : 'TZS';
    payRecvChanged(false);
    if (prefill) { document.getElementById('pay-rate').value = ''; document.getElementById('pay-amount').value = formatMoney(inv.balance); }
    payConvNote();
}
function payInv() { return currentInvoices.find(i => String(i.invoice_id) === document.getElementById('pay-invoice-id').value); }
function payRecvChanged(userChanged) {
    const inv = payInv(); if (!inv) return;
    const rc = document.getElementById('pay-recv-cur').value, ic = inv.currency === 'USD' ? 'USD' : 'TZS';
    document.getElementById('pay-cur-label').innerText = 'Amount received (' + rc + ') *';
    document.getElementById('pay-rate-wrap').classList.toggle('hidden', rc === ic);
    fillAccountSelect('pay-account', rc, userChanged ? '' : document.getElementById('pay-account').value);
    if (userChanged) document.getElementById('pay-amount').value = rc === ic ? formatMoney(inv.balance) : '';
    payConvNote();
}
// how much of the invoice the money pays, using the rate
function payConvNote() {
    const inv = payInv(), box = document.getElementById('pay-conv-note'); if (!inv || !box) return;
    const rc = document.getElementById('pay-recv-cur').value, ic = inv.currency === 'USD' ? 'USD' : 'TZS';
    const amt = parseMoney(document.getElementById('pay-amount').value), rate = parseMoney(document.getElementById('pay-rate').value);
    if (rc === ic || !(amt > 0)) { box.innerText = ''; return; }
    if (!(rate > 0)) { box.innerText = 'Enter the exchange rate.'; return; }
    const credited = ic === 'USD' ? Math.round(amt / rate * 100) / 100 : Math.round(amt * rate);
    box.innerText = '= ' + money(credited, ic) + ' will be taken off this invoice';
}
async function submitPayment(e) {
    e.preventDefault();
    const invoiceId = document.getElementById('pay-invoice-id').value;
    const amount = parseMoney(document.getElementById('pay-amount').value);
    const inv0 = payInv(), rc = document.getElementById('pay-recv-cur').value, other = inv0 && rc !== (inv0.currency === 'USD' ? 'USD' : 'TZS');
    const rate = parseMoney(document.getElementById('pay-rate').value);
    if (other && !(rate > 0)) return alert('Please enter the exchange rate.');
    if (!invoiceId) return alert('Please choose an invoice.');
    if (!(amount > 0)) return alert('Please enter the amount received.');
    const r = await api('/api/payments/record', 'POST', {
        invoice_id: parseInt(invoiceId), amount, payment_method: document.getElementById('pay-method').value,
        payment_date: document.getElementById('pay-date').value || undefined, reference: document.getElementById('pay-ref').value, notes: document.getElementById('pay-notes').value,
        account_id: document.getElementById('pay-account').value || undefined,
        received_currency: other ? rc : undefined, exchange_rate: other ? rate : undefined
    });
    if (!r.ok) return alert(r.data.error || 'Failed');
    closeModal('modal-payment'); loadAllData();
    if (r.data.payment_id) showReceipt(r.data.payment_id);
}

// ---- receipts ----
async function loadReceipts() {
    const f = document.getElementById('rc-from').value, t = document.getElementById('rc-to').value;
    const r = await api(`/api/payments?${f ? 'from=' + f + '&' : ''}${t ? 'to=' + t : ''}`);
    if (r.ok) { receiptsData = r.data; renderReceipts(); }
}
function renderReceipts() {
    const tb = document.getElementById('table-receipts-body'); if (!tb) return;
    const q = (document.getElementById('rc-search')?.value || '').toLowerCase().trim();
    const rows = receiptsData.filter(p => !q || [p.receipt_number, p.tenant_name, p.invoice_number, p.unit_number, p.reference_no].some(v => String(v || '').toLowerCase().includes(q)));
    const total = rows.reduce((s, p) => s + Number(p.amount_paid), 0);
    tb.innerHTML = rows.length === 0 ? '<tr><td colspan="7" class="p-4 text-center text-gray-500">No payments found.</td></tr>' :
        rows.map(p => `<tr class="hover:bg-[#14223d]/50">
            <td class="p-3 font-mono font-bold text-emerald-400">${esc(p.receipt_number || 'Old payment')}</td><td class="p-3">${fmtDate(p.payment_date)}</td>
            <td class="p-3 font-bold text-white">${esc(p.tenant_name)}<div class="text-[10px] text-gray-500 font-normal">${esc(p.property_name)} (${esc(p.unit_number)})</div></td>
            <td class="p-3 text-purple-300">${esc(p.invoice_number)} <span class="text-gray-500">· ${esc(TYPE_LABEL[p.invoice_type || 'RENT'] || '')}</span></td>
            <td class="p-3">${esc(p.method_detail || p.payment_method || '')}${p.reference_no ? `<div class="text-[10px] text-gray-500">${esc(p.reference_no)}</div>` : ''}</td>
            <td class="p-3 font-bold text-emerald-400">${money(p.amount_paid, p.currency)}</td>
            <td class="p-3"><button onclick="showReceipt(${Number(p.payment_id)})" class="px-2.5 py-1 bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 rounded font-bold hover:bg-cyan-600 hover:text-white"><i class="fa-solid fa-receipt"></i> Receipt</button></td></tr>`).join('') +
        `<tr class="bg-[#14223d] font-bold"><td class="p-3" colspan="5">Total (${rows.length})</td><td class="p-3 text-emerald-400">${money(total)}</td><td></td></tr>`;
}
async function showReceipt(paymentId) {
    const r = await api(`/api/payments/${paymentId}/receipt`);
    if (!r.ok) return alert(r.data.error || 'Could not load the receipt.');
    const d = lastReceiptData = r.data;
    const moneyC = n => money(n, d.currency);
    const recvLine = d.received_currency ? `<div style="font-size:11px;margin-top:6px">Paid in ${esc(d.received_currency)}: ${money(d.received_amount, d.received_currency)} at 1 USD = TZS ${fmtN(d.exchange_rate)}</div>` : '';
    document.getElementById('receipt-printable-area').innerHTML = `
        <div class="space-y-5">
        <div class="flex justify-between items-start border-b pb-4 gap-4">
            ${companyHeader(d.company)}
            <div class="text-right shrink-0"><div class="text-xl font-black text-emerald-700 tracking-wide">RECEIPT</div>
                <p class="text-sm font-bold text-slate-700 mt-1">${esc(d.receipt_number)}</p><p class="text-xs text-slate-500">Date: ${fmtDate(d.payment_date)}</p></div>
        </div>
        <div class="text-xs space-y-1.5">
            <div class="flex justify-between"><span class="text-slate-500">Received from</span><b class="text-slate-900">${esc(d.tenant_name)}</b></div>
            <div class="flex justify-between"><span class="text-slate-500">Property / Unit</span><b>${esc(d.property_name)} · ${esc(d.unit_number)}</b></div>
            <div class="flex justify-between"><span class="text-slate-500">For invoice</span><b>${esc(d.invoice.invoice_number)} — ${esc(d.invoice.description || TYPE_LABEL[d.invoice.invoice_type] || '')}</b></div>
            <div class="flex justify-between"><span class="text-slate-500">Payment method</span><b>${esc(d.method || '')}${d.reference ? ' · Ref ' + esc(d.reference) : ''}</b></div>
        </div>
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
            <div class="text-[11px] uppercase tracking-wider text-emerald-700 font-bold">Amount received</div>
            <div class="text-3xl font-black text-emerald-800">${esc(d.currency || 'TZS')} ${fmtN(d.amount_paid)}</div>
            <div class="text-[11px] text-emerald-700 capitalize mt-1">${esc(d.amount_words)}</div>${recvLine}
        </div>
        <div class="text-xs space-y-1">
            <div class="flex justify-between"><span class="text-slate-500">Invoice total</span><span>${moneyC(d.invoice.total)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Paid to date</span><span>${moneyC(d.paid_to_date)}</span></div>
            <div class="flex justify-between font-bold ${d.balance_after > 0 ? 'text-rose-700' : 'text-emerald-700'}"><span>${d.balance_after > 0 ? 'Balance remaining' : 'Fully paid'}</span><span>${d.balance_after > 0 ? moneyC(d.balance_after) : (d.extra_paid > 0 ? 'Credit ' + moneyC(d.extra_paid) : '✔')}</span></div>
        </div>
        ${d.notes ? `<p class="text-xs text-slate-500">Note: ${esc(d.notes)}</p>` : ''}
        <div class="flex justify-between items-end pt-6 text-[11px] text-slate-500"><div>Received by: <b class="text-slate-700">${esc(d.received_by || '')}</b></div><div class="border-t border-slate-400 pt-1 w-40 text-center">Signature / Stamp</div></div>
        <div class="text-center text-[10px] text-slate-400">Thank you. · Generated by KEY ARCH</div>
        </div>`;
    openModal('modal-receipt');
}

// ---- service charges ----
async function openServiceGen() {
    document.getElementById('sv-month').value = todayISO().slice(0, 7);
    const sel = document.getElementById('sv-prop');
    sel.innerHTML = '<option value="">All properties</option>' + propertiesData.map(p => `<option value="${esc(p.property_id)}">${esc(p.property_name)}</option>`).join('');
    openModal('modal-service'); loadServiceStatus();
}
async function loadServiceStatus() {
    const m = document.getElementById('sv-month').value, p = document.getElementById('sv-prop').value;
    const r = await api(`/api/service-charges/status?month=${m}${p ? '&property_id=' + p : ''}`);
    if (!r.ok) return alert(r.data.error || 'Failed');
    const s = r.data.summary;
    document.getElementById('sv-summary').innerHTML = [
        ['Units charged', s.units, 'text-white'], ['Paid', s.paid, 'text-emerald-400'], ['Not paid', s.not_paid_total, 'text-rose-400'], ['Inclusive in rent', s.inclusive, 'text-sky-300']
    ].map(x => `<div class="p-3 bg-[#14223d] rounded-xl"><div class="text-[10px] text-gray-400 uppercase">${x[0]}</div><div class="text-lg font-black ${x[2]}">${x[1]}</div></div>`).join('');
    document.getElementById('sv-list').innerHTML = r.data.items.length === 0 ? '<div class="p-4 text-center text-gray-500">No occupied units with a service charge.</div>' :
        r.data.items.map(i => `<div class="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[#14223d]">
            <div class="min-w-0"><span class="font-bold text-white">${esc(i.tenant_name)}</span> <span class="text-gray-500">· ${esc(i.property_name)} (${esc(i.unit_number)})</span></div>
            <div class="flex items-center gap-2 whitespace-nowrap">${money(i.service_charge)} ${svcBadge(i.status)}
                ${['UNPAID', 'PARTIAL'].includes(i.status) ? `<button onclick="closeModal('modal-service'); openPaymentModal(${Number(i.invoice_id)})" class="px-2 py-0.5 rounded bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold">Pay</button>` : ''}
                ${i.status !== 'PAID' && i.status !== 'INCLUSIVE' ? contactBtns(i.tenant_phone, `Habari ${i.tenant_name}, tafadhali lipia ${'service charge'} ya mwezi huu (${money(i.service_charge)}). Asante.`, true) : ''}</div></div>`).join('');
}
async function generateService() {
    const m = document.getElementById('sv-month').value, p = document.getElementById('sv-prop').value;
    const r = await api('/api/service-charges/generate', 'POST', { month: m, property_id: p || undefined });
    alert(r.ok ? r.data.message : (r.data.error || 'Failed'));
    if (r.ok) { loadAllData(); loadServiceStatus(); }
}

async function loadInvoices() {
    const r = await api('/api/invoices');
    if (!r.ok) return;
    currentInvoices = r.data; renderInvoicesTable();
    if (invTab === 'receipts') loadReceipts();
}

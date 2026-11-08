// ============================================================
// INVOICES & PAYMENTS
// ============================================================
// ============================================================
// TENANTS: overview, filters, history, edit, renew, extend, move out
// ============================================================
let tenantFilter = 'current';
let tenantSearchText = '';
let activeLeaseAction = null;

function currentUserInfo() { return JSON.parse(localStorage.getItem('keyarch_user') || '{}'); }
function canManageLeases() { return ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'].includes(currentUserInfo().role); }
function canEditTenantInfo() { const u = currentUserInfo(); return u.role === 'SUPER_ADMIN' || u.role === 'COMPANY_ADMIN' || !!u.can_edit_tenants; }
function canDeleteTenants() { return ['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(currentUserInfo().role); }

function dateOnly(v) { return v ? String(v).split('T')[0] : ''; }
function toDateInput(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addPeriodsToDate(dateStr, period, n) {
    const d = new Date(dateStr + 'T00:00:00');
    if (period === 'Day') d.setDate(d.getDate() + Math.round(n));
    else if (period === 'Week') d.setDate(d.getDate() + Math.round(n * 7));
    else if (period === 'Year') { const w = Math.floor(n); d.setFullYear(d.getFullYear() + w); d.setDate(d.getDate() + Math.round((n - w) * 365)); }
    else { const w = Math.floor(n); d.setMonth(d.getMonth() + w); d.setDate(d.getDate() + Math.round((n - w) * 30)); }
    return toDateInput(d);
}

// Past / Contract finished / Ending soon / Active
function tenantStatus(t) {
    if (t.lease_state !== 'CURRENT') return 'past';
    if (t.days_left === null || t.days_left === undefined) return 'active';
    const d = Number(t.days_left);
    if (d < 0) return 'expired';
    if (d <= 30) return 'ending';
    return 'active';
}

function setTenantFilter(f) {
    tenantFilter = f;
    syncFilterChips();
    if (document.getElementById('page-tenants').classList.contains('hidden')) showPage('tenants');
    applyTenantFilters();
}
function syncFilterChips() {
    document.querySelectorAll('.tf-chip').forEach(chip => {
        const on = chip.dataset.filter === tenantFilter;
        chip.classList.toggle('bg-blue-600', on);
        chip.classList.toggle('text-white', on);
        chip.classList.toggle('border-blue-500', on);
        chip.classList.toggle('text-gray-400', !on);
    });
}
function filterTenants(query) {
    tenantSearchText = String(query || '').toLowerCase().trim();
    applyTenantFilters();
}

function renderTenantOverview() {
    const list = currentTenantsList;
    const current = list.filter(t => t.lease_state === 'CURRENT');
    const owing = list.filter(t => Number(t.balance_owed) > 0);
    setText('ten-kpi-active', current.length);
    setText('ten-kpi-owing', owing.length);
    setText('ten-kpi-owing-amt', money(owing.reduce((s, t) => s + Number(t.balance_owed), 0)));
    setText('ten-kpi-ending', list.filter(t => tenantStatus(t) === 'ending').length);
    setText('ten-kpi-expired', list.filter(t => tenantStatus(t) === 'expired').length);
    syncFilterChips();
}

function applyTenantFilters() {
    const q = tenantSearchText;
    const rows = currentTenantsList.filter(t => {
        const st = tenantStatus(t);
        const passFilter =
            tenantFilter === 'all' ? true :
            tenantFilter === 'current' ? st !== 'past' :
            tenantFilter === 'owing' ? Number(t.balance_owed) > 0 :
            st === tenantFilter;
        if (!passFilter) return false;
        if (!q) return true;
        return [t.full_name, t.phone_number, t.nida_passport_no, t.property_name, t.unit_number]
            .some(v => String(v || '').toLowerCase().includes(q));
    });
    renderTenantsTable(rows);
}

function statusBadge(st, t) {
    const d = Number(t.days_left);
    if (st === 'past') return '<span class="px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-300 border border-gray-600/40">Moved Out</span>';
    if (st === 'expired') return `<span class="px-2 py-0.5 rounded text-[10px] bg-red-900/40 text-red-300 border border-red-500/30">Finished ${Math.abs(d)}d ago</span>`;
    if (st === 'ending') return `<span class="px-2 py-0.5 rounded text-[10px] bg-amber-900/40 text-amber-300 border border-amber-500/30">${d === 0 ? 'Ends today' : d + ' days left'}</span>`;
    return '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-900/40 text-emerald-300 border border-emerald-500/30">Active</span>';
}

function renderTenantsTable(tenants) {
    const tbody = document.getElementById('tenants-table-body');
    if (!tbody) return;
    if (tenants.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="p-4 text-center text-gray-500">No tenants found in this view.</td></tr>';
        updateTenantBulk(); return;
    }
    const manage = canManageLeases();
    renderedTenantIds = tenants.map(t => Number(t.tenant_id));

    tbody.innerHTML = tenants.map(t => {
        const st = tenantStatus(t);
        const owed = Number(t.balance_owed);
        const toPay = Number(t.total_to_pay), paid = Number(t.amount_paid);
        const extra = paid - toPay;
        const quick = !manage || st === 'past' ? '' :
            (st === 'expired' || st === 'ending'
                ? `<button onclick="openLeaseAction('renew', ${Number(t.tenant_id)})" class="px-2 py-1 bg-emerald-600/30 text-emerald-300 border border-emerald-500/50 rounded font-bold hover:bg-emerald-600 hover:text-white transition">Renew</button>`
                : `<button onclick="openLeaseAction('extend', ${Number(t.tenant_id)})" class="px-2 py-1 bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 rounded font-bold hover:bg-cyan-600 hover:text-white transition">Extend</button>`);
        return `
        <tr class="hover:bg-[#14223d]/50">
            <td class="p-3 sel-col"><input type="checkbox" ${selTenants.has(Number(t.tenant_id)) ? 'checked' : ''} onchange="toggleTenantSel(${Number(t.tenant_id)}, this.checked)"></td>
            <td class="p-3 font-bold text-white">${esc(t.full_name)}<div class="text-[10px] text-gray-500 font-normal">${esc(t.phone_number)}${Number(t.lease_count) > 1 ? ' · ' + Number(t.lease_count) + ' leases' : ''}</div></td>
            <td class="p-3 text-cyan-300 font-semibold">${esc(t.property_name)} <span class="text-gray-400">(${esc(t.unit_number)})</span></td>
            <td class="p-3 text-gray-300 whitespace-nowrap">${fmtDate(t.start_date)} <span class="text-gray-600">→</span> ${fmtDate(t.end_date, 'No end date')}</td>
            <td class="p-3 font-bold text-gray-200">${money(toPay)}</td>
            <td class="p-3 font-bold text-emerald-400">${money(paid)}${extra > 0 ? `<div class="text-[10px] text-sky-400 font-normal">Extra ${money(extra)}</div>` : ''}</td>
            <td class="p-3 font-bold ${owed > 0 ? 'text-rose-400' : 'text-gray-500'}">${owed > 0 ? money(owed) : '-'}</td>
            <td class="p-3">${statusBadge(st, t)}</td>
            <td class="p-3 whitespace-nowrap space-x-1">
                <button onclick="openTenantDetail(${Number(t.tenant_id)})" class="px-2 py-1 bg-[#1e2f52] text-gray-200 border border-[#233863] rounded font-bold hover:bg-blue-600 hover:text-white transition"><i class="fa-solid fa-eye"></i> View</button>
                ${quick}
                ${contactBtns(t.phone_number, owed > 0 ? remindText(t.full_name, owed, companyName()) : '', true)}
            </td>
        </tr>`;
    }).join('');
    updateTenantBulk();
}

// ------------------------------------------------------------
// TENANT DETAILS + HISTORY
// ------------------------------------------------------------
function leaseStateBadge(s) {
    if (s === 'CURRENT') return '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-900/40 text-emerald-300 border border-emerald-500/30">Current</span>';
    if (s === 'RENEWED') return '<span class="px-2 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-300 border border-blue-500/30">Renewed</span>';
    return '<span class="px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-300 border border-gray-600/40">Ended</span>';
}
const EVENT_LABELS = { CREATED: 'Lease started', RENEWED: 'Contract renewed', EXTENDED: 'Stay extended', EDITED: 'Details edited', MOVED_OUT: 'Moved out' };
const EVENT_ICONS = { CREATED: 'fa-circle-plus text-emerald-400', RENEWED: 'fa-rotate text-blue-400', EXTENDED: 'fa-calendar-plus text-cyan-400', EDITED: 'fa-pen text-amber-400', MOVED_OUT: 'fa-door-open text-gray-400' };

async function openTenantDetail(tenantId) {
    const body = document.getElementById('td-body');
    body.innerHTML = '<div class="p-10 text-center text-gray-500 text-xs">Loading...</div>';
    openModal('modal-tenant-detail');
    try {
        const token = localStorage.getItem('keyarch_token');
        const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/history`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Server error');
        renderTenantDetail(data);
    } catch (err) {
        body.innerHTML = `<div class="p-10 text-center text-rose-400 text-xs">Could not load history: ${esc(err.message)}</div>`;
    }
}

function renderTenantDetail(h) {
    const t = h.tenant;
    const cur = h.leases.find(l => l.lease_state === 'CURRENT');
    const owed = Number(h.totals.balance);
    const idLabels = { NIDA: 'NIDA', PASSPORT: 'Passport', DRIVING_LICENSE: 'Driving License', VOTER_ID: 'Voter ID' };
    const manage = canManageLeases();

    const buttons = [];
    if (manage || canEditTenantInfo()) buttons.push(`<button onclick="openEditChoose(${Number(t.tenant_id)})" class="px-3 py-2 rounded-xl bg-amber-600/30 text-amber-300 border border-amber-500/50 font-bold hover:bg-amber-600 hover:text-white transition"><i class="fa-solid fa-pen"></i> Edit</button>`);
    if (manage && cur) {
        buttons.push(`<button onclick="openLeaseAction('renew', ${Number(t.tenant_id)})" class="px-3 py-2 rounded-xl bg-emerald-600/30 text-emerald-300 border border-emerald-500/50 font-bold hover:bg-emerald-600 hover:text-white transition"><i class="fa-solid fa-rotate"></i> Renew Contract</button>`);
        buttons.push(`<button onclick="openLeaseAction('extend', ${Number(t.tenant_id)})" class="px-3 py-2 rounded-xl bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 font-bold hover:bg-cyan-600 hover:text-white transition"><i class="fa-solid fa-calendar-plus"></i> Extend Stay</button>`);
    }
    if (owed > 0 && canMoney()) buttons.push(`<button onclick="closeModal('modal-tenant-detail'); openPaymentModal()" class="px-3 py-2 rounded-xl bg-purple-600/30 text-purple-300 border border-purple-500/50 font-bold hover:bg-purple-600 hover:text-white transition"><i class="fa-solid fa-hand-holding-dollar"></i> Record Payment</button>`);
    if (manage && cur) buttons.push(`<button onclick="moveOutTenant(${Number(t.tenant_id)}, ${Number(cur.lease_id)}, ${owed})" class="px-3 py-2 rounded-xl bg-orange-600/30 text-orange-300 border border-orange-500/50 font-bold hover:bg-orange-600 hover:text-white transition"><i class="fa-solid fa-right-from-bracket"></i> Move Out</button>`);
    if (t.phone_number) buttons.push(contactBtns(t.phone_number, owed > 0 ? remindText(t.full_name, owed, companyName()) : ''));
    if (canMoney() && cur) buttons.push(`<button onclick="closeModal('modal-tenant-detail'); openInvoiceModal(${Number(cur.lease_id)})" class="px-3 py-2 rounded-xl bg-purple-600/30 text-purple-300 border border-purple-500/50 font-bold hover:bg-purple-600 hover:text-white transition"><i class="fa-solid fa-file-invoice-dollar"></i> New Invoice</button>`);
    if (canDeleteTenants() && h.payments.length === 0) buttons.push(`<button onclick="deleteTenant(${Number(t.tenant_id)})" class="px-3 py-2 rounded-xl bg-red-600/20 text-red-300 border border-red-500/40 font-bold hover:bg-red-600 hover:text-white transition"><i class="fa-solid fa-trash-can"></i> Delete</button>`);

    const leasesHtml = h.leases.map(l => {
        const toPay = Number(l.total_to_pay ?? l.agreed_rent ?? 0);
        const rentTxt = l.rent_price ? `${money(l.rent_price, l.currency)} per ${esc(l.rent_period || 'Month')} × ${Number(l.number_of_periods) || 1}` : 'Rent';
        return `
        <div class="p-3 rounded-xl bg-[#14223d] border ${l.lease_state === 'CURRENT' ? 'border-emerald-500/40' : 'border-[#233863]'} text-xs">
            <div class="flex justify-between items-start gap-2">
                <div>
                    <div class="font-bold text-white">${esc(l.property_name)} <span class="text-gray-400">(${esc(l.unit_number)})</span></div>
                    <div class="text-gray-400 mt-0.5">${esc(l.start_str)} → ${esc(l.end_str)}</div>
                </div>
                ${leaseStateBadge(l.lease_state)}
            </div>
            <div class="grid grid-cols-3 gap-2 mt-2 text-[11px]">
                <div><div class="text-gray-500">Rent</div><div class="text-gray-200">${rentTxt}</div></div>
                <div><div class="text-gray-500">Total To Pay</div><div class="font-bold text-white">${money(toPay)}</div></div>
                <div><div class="text-gray-500">Paid</div><div class="font-bold text-emerald-400">${money(l.amount_paid, l.currency)}</div></div>
            </div>
            ${l.ended_reason && l.lease_state !== 'CURRENT' ? `<div class="text-[10px] text-gray-500 mt-1.5">${esc(l.ended_reason)}</div>` : ''}
        </div>`;
    }).join('');

    const invHtml = h.invoices.length === 0 ? '<div class="p-3 text-center text-gray-500">No invoices.</div>' : h.invoices.map(i => {
        const bal = Number(i.amount_due) - Number(i.paid);
        return `
        <div class="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[#14223d] text-xs">
            <div class="min-w-0"><span class="font-mono font-bold text-purple-400">${esc(i.invoice_number)}</span>
                <span class="text-gray-300"> ${esc(TYPE_LABEL[i.invoice_type || 'RENT'] || '')}</span><span class="text-gray-500"> · due ${fmtDate(i.due_date)}</span></div>
            <div class="text-right whitespace-nowrap">
                <span class="text-gray-300">${money(i.amount_due, i.currency)}</span>
                <span class="ml-2 font-bold ${bal > 0 ? 'text-rose-400' : 'text-emerald-400'}">${bal > 0 ? 'owes ' + money(bal, i.currency) : 'paid'}</span>
                ${bal > 0 ? `<button onclick="closeModal('modal-tenant-detail'); openPaymentModal(${Number(i.invoice_id)})" class="ml-2 px-2 py-0.5 rounded bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold hover:bg-emerald-600 hover:text-white">Pay</button>` : ''}
                <button onclick="closeModal('modal-tenant-detail'); showInvoiceModal(${Number(i.invoice_id)})" class="ml-1 px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-600 hover:text-white"><i class="fa-solid fa-print"></i></button>
            </div>
        </div>`;
    }).join('');

    const payHtml = h.payments.length === 0 ? '<div class="p-3 text-center text-gray-500">No payments yet.</div>' : h.payments.map(p => `
        <div class="flex justify-between p-2.5 rounded-lg bg-[#14223d] text-xs">
            <span class="text-gray-300">${fmtDate(p.payment_date)} <span class="text-gray-500">· ${esc(p.receipt_number || '')} · ${esc(p.invoice_number)} · ${esc(p.method_detail || p.payment_method || '')}</span></span>
            <span class="whitespace-nowrap"><span class="font-bold text-emerald-400">${money(p.amount_paid, p.currency || (cur && cur.currency) || 'TZS')}</span> <button onclick="closeModal('modal-tenant-detail'); showReceipt(${Number(p.payment_id)})" class="ml-1 px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-600 hover:text-white"><i class="fa-solid fa-receipt"></i></button></span>
        </div>`).join('');

    const evHtml = h.events.length === 0 ? '<div class="p-3 text-center text-gray-500">No activity recorded yet.</div>' : h.events.map(e => `
        <div class="flex gap-3 p-2.5 rounded-lg bg-[#14223d] text-xs">
            <i class="fa-solid ${EVENT_ICONS[e.event_type] || 'fa-circle text-gray-400'} mt-0.5 w-4 text-center"></i>
            <div class="min-w-0"><div class="font-bold text-white">${esc(EVENT_LABELS[e.event_type] || e.event_type)} <span class="text-gray-500 font-normal">· ${fmtDate(e.created_at)}</span></div>
                <div class="text-gray-400">${esc(e.description || '')}</div></div>
        </div>`).join('');

    document.getElementById('td-body').innerHTML = `
        <div class="flex flex-wrap justify-between items-start gap-3">
            <div>
                <div class="text-lg font-black text-white">${esc(t.full_name)}</div>
                <div class="text-xs text-gray-400">${esc(t.phone_number)} · ${esc(idLabels[t.identity_type] || 'ID')}: ${esc(t.nida_passport_no)}</div>
            </div>
            <div class="text-right">
                <div class="text-[10px] text-gray-500 uppercase">Balance Owed</div>
                <div class="text-xl font-black ${owed > 0 ? 'text-rose-400' : 'text-emerald-400'}">${owed > 0 ? money(owed) : 'None'}</div>
            </div>
        </div>
        <div class="flex flex-wrap gap-2 text-xs">${buttons.join('')}</div>
        <div class="grid grid-cols-3 gap-3 text-xs">
            <div class="p-3 rounded-xl border border-[#182848]"><div class="text-gray-500 text-[10px] uppercase">Total Billed</div><div class="font-black text-white">${money(h.totals.billed)}</div></div>
            <div class="p-3 rounded-xl border border-[#182848]"><div class="text-gray-500 text-[10px] uppercase">Total Paid</div><div class="font-black text-emerald-400">${money(h.totals.paid)}</div></div>
            <div class="p-3 rounded-xl border border-[#182848]"><div class="text-gray-500 text-[10px] uppercase">Leases</div><div class="font-black text-white">${h.leases.length}</div></div>
        </div>
        <div><div class="text-xs font-bold text-white uppercase tracking-wider mb-2">Leases (newest first)</div><div class="space-y-2">${leasesHtml}</div></div>
        <div><div class="text-xs font-bold text-white uppercase tracking-wider mb-2">Invoices</div><div class="space-y-1.5">${invHtml}</div></div>
        <div><div class="text-xs font-bold text-white uppercase tracking-wider mb-2">Payments</div><div class="space-y-1.5">${payHtml}</div></div>
        <div><div class="text-xs font-bold text-white uppercase tracking-wider mb-2">Activity</div><div class="space-y-1.5">${evHtml}</div></div>
    `;
}

// ------------------------------------------------------------
// EDIT TENANT
// ------------------------------------------------------------
function openEditTenant(tenantId) {
    const t = currentTenantsList.find(x => String(x.tenant_id) === String(tenantId));
    if (!t) return;
    document.getElementById('te-tenant-id').value = t.tenant_id;
    document.getElementById('te-lease-id').value = t.lease_state === 'CURRENT' ? t.lease_id : '';
    document.getElementById('te-name').value = t.full_name || '';
    document.getElementById('te-phone').value = t.phone_number || '';
    document.getElementById('te-id-type').value = t.identity_type || 'NIDA';
    document.getElementById('te-id-no').value = t.nida_passport_no || '';
    document.getElementById('te-end').value = dateOnly(t.end_date);
    document.getElementById('te-end-wrap').style.display = t.lease_state === 'CURRENT' ? 'block' : 'none';
    closeModal('modal-tenant-detail');
    openModal('modal-tenant-edit');
}

async function submitEditTenant(e) {
    e.preventDefault();
    const id = document.getElementById('te-tenant-id').value;
    const leaseId = document.getElementById('te-lease-id').value;
    const token = localStorage.getItem('keyarch_token');
    const res = await fetch(`/api/tenants/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
            full_name: document.getElementById('te-name').value,
            phone_number: document.getElementById('te-phone').value,
            identity_type: document.getElementById('te-id-type').value,
            nida_passport_no: document.getElementById('te-id-no').value,
            end_date: leaseId ? document.getElementById('te-end').value : undefined,
            lease_id: leaseId || undefined,
            request_id: editCtx.requestId || undefined
        })
    });
    const data = await res.json();
    if (res.ok) { closeModal('modal-tenant-edit'); loadAllData(); alert('Tenant updated.'); refreshRequestBadge(); }
    else if (!needsApproval(data)) alert('Failed: ' + (data.error || 'Server error'));
}

// ------------------------------------------------------------
// RENEW CONTRACT / EXTEND STAY
// ------------------------------------------------------------
function openLeaseAction(mode, tenantId) {
    const t = currentTenantsList.find(x => String(x.tenant_id) === String(tenantId));
    if (!t || t.lease_state !== 'CURRENT') { alert('This tenant has no current lease.'); return; }
    activeLeaseAction = { mode, t };

    const period = t.rent_period || 'Month';
    const endStr = dateOnly(t.end_date);
    const rent = Number(t.rent_price) || Number(t.total_to_pay) || 0;
    const periodsInput = document.getElementById('la-periods');
    periodsInput.dataset.manual = '';

    const isRenew = mode === 'renew';
    setText('la-title', isRenew ? 'Renew Contract' : 'Extend Stay');
    setText('la-subtitle', `${t.full_name} · ${t.property_name} (${t.unit_number})`);
    setText('la-start-label', isRenew ? 'New Lease Start *' : 'Current End Date');
    setText('la-end-label', isRenew ? 'New Lease End' : 'New End Date *');
    setText('la-sum-total-label', isRenew ? 'Total Rent' : 'Extension Charge');
    setText('la-submit', isRenew ? 'Renew & Create Invoice →' : 'Extend & Create Invoice →');

    const startEl = document.getElementById('la-start');
    const periodEl = document.getElementById('la-period');
    startEl.value = endStr;
    startEl.disabled = !isRenew;
    periodEl.value = period;
    periodEl.disabled = !isRenew;       // extension keeps the same way of charging
    document.getElementById('la-end').value = isRenew
        ? addPeriodsToDate(endStr, period, Number(t.number_of_periods) || 1)
        : addPeriodsToDate(endStr, period, 1);
    document.getElementById('la-rent').value = formatMoney(rent);
    document.getElementById('la-discount').value = '';
    document.getElementById('la-paid').value = '';

    closeModal('modal-tenant-detail');
    onLeaseActionDates();
    openModal('modal-lease-action');
}

function onLeaseActionDates() {
    const period = document.getElementById('la-period').value;
    setText('la-periods-label', activeLeaseAction && activeLeaseAction.mode === 'extend'
        ? `Extra ${period === 'Day' ? 'Days' : period + 's'}`
        : `Number of ${period === 'Day' ? 'Days' : period + 's'}`);
    const input = document.getElementById('la-periods');
    if (input.dataset.manual !== '1') {
        input.value = countPeriods(
            document.getElementById('la-start').value,
            document.getElementById('la-end').value,
            period
        ) || '';
    }
    calcLeaseAction();
}

function leaseActionFigures() {
    const rate = parseMoney(document.getElementById('la-rent').value);
    const periods = parseFloat(document.getElementById('la-periods').value) || 0;
    const total = Math.round(rate * periods);
    const discount = Math.min(parseMoney(document.getElementById('la-discount').value), total);
    const toPay = total - discount;
    const paid = parseMoney(document.getElementById('la-paid').value);
    return { rate, periods, total, discount, toPay, paid, balance: toPay - paid };
}

function calcLeaseAction() {
    const f = leaseActionFigures();
    setText('la-sum-total', money(f.total));
    setText('la-sum-discount', '- ' + money(f.discount));
    setText('la-sum-topay', money(f.toPay));
    setText('la-sum-paid', money(f.paid));
    const label = document.getElementById('la-sum-label'), value = document.getElementById('la-sum-value');
    if (f.toPay === 0) { label.innerText = 'Remaining Balance'; value.innerText = 'TZS 0'; value.className = 'text-sm font-black text-gray-400'; }
    else if (f.balance > 0) { label.innerText = 'Remaining Balance'; value.innerText = money(f.balance); value.className = 'text-sm font-black text-rose-400'; }
    else if (f.balance === 0) { label.innerText = 'Fully Paid'; value.innerText = '✔ TZS 0 left'; value.className = 'text-sm font-black text-emerald-400'; }
    else { label.innerText = 'Extra Paid (tenant paid more)'; value.innerText = money(-f.balance); value.className = 'text-sm font-black text-sky-400'; }
}

async function submitLeaseAction(e) {
    e.preventDefault();
    if (!activeLeaseAction) return;
    const { mode, t } = activeLeaseAction;
    const f = leaseActionFigures();
    if (f.rate <= 0 || f.periods <= 0) return alert('Please check the Rent Price and the dates / number of periods.');

    const payload = mode === 'renew'
        ? { start_date: document.getElementById('la-start').value, end_date: document.getElementById('la-end').value,
            rent_price: f.rate, rent_period: document.getElementById('la-period').value,
            number_of_periods: f.periods, discount: f.discount, paid_amount: f.paid }
        : { new_end_date: document.getElementById('la-end').value, extra_periods: f.periods,
            rent_price: f.rate, discount: f.discount, paid_amount: f.paid };
    if (mode === 'extend' && !payload.new_end_date) return alert('Please choose the new end date.');

    const token = localStorage.getItem('keyarch_token');
    const res = await fetch(`/api/leases/${encodeURIComponent(t.lease_id)}/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return alert('Failed: ' + (data.error || 'Server error'));

    closeModal('modal-lease-action');
    loadAllData();
    if (data.invoice) showInvoiceModal(data.invoice.invoice_id);
}

// ------------------------------------------------------------
// MOVE OUT / DELETE
// ------------------------------------------------------------
async function moveOutTenant(tenantId, leaseId, owed) {
    const t = currentTenantsList.find(x => String(x.tenant_id) === String(tenantId));
    const name = t ? t.full_name : 'this tenant';
    let msg = `Move out ${name}?\n\nThe unit will become vacant and ${name} stays in your history.`;
    if (owed > 0) msg += `\n\nNote: ${name} still owes ${money(owed)}. The balance stays recorded.`;
    if (!confirm(msg)) return;

    const token = localStorage.getItem('keyarch_token');
    const res = await fetch(`/api/leases/${encodeURIComponent(leaseId)}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ reason: 'Moved out' })
    });
    const data = await res.json();
    if (res.ok) { closeModal('modal-tenant-detail'); loadAllData(); alert(data.message); }
    else alert('Failed: ' + (data.error || 'Server error'));
}

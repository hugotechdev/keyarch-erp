// ============================================================
// UNIT OWNERS + SERVICE CHARGE (Pro)
// ============================================================

let SO_UNITS = {};
async function billOwners() {
    const yr = document.getElementById('so-year').value;
    const ans = (prompt('Bill owners who live in their units.\nType 1 = this month only, 2 = every month of ' + yr + ' so far.', '1') || '').trim();
    if (ans !== '1' && ans !== '2') return;
    const d = new Date(); const mo = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const r = await api('/api/owner-charges/generate', 'POST', ans === '1' ? { month: mo } : { year: Number(yr) });
    alert(r.ok ? r.data.message : (r.data.error || 'Failed'));
    if (r.ok) loadSvcOwners();
}
function openOwnerPay(unitId) {
    const u = SO_UNITS[unitId]; if (!u) return;
    const open = (u.charges || []).filter(c => c.amount - c.paid > 0.001);
    if (!open.length) return alert('Nothing is owed on this unit.');
    document.getElementById('op-unit').innerText = `${u.property_name} · ${u.unit_number}`;
    document.getElementById('op-charge').innerHTML = open.map(c => `<option value="${c.charge_id}" data-left="${c.amount - c.paid}">${esc(c.period)} · owes ${money(c.amount - c.paid, u.currency)}</option>`).join('');
    document.getElementById('op-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('op-ref').value = '';
    opPick(); openModal('modal-owner-pay');
}
function opPick() {
    const o = document.getElementById('op-charge').selectedOptions[0];
    document.getElementById('op-amount').value = o ? formatMoney(o.dataset.left) : '';
}
async function saveOwnerPay(e) {
    e.preventDefault();
    const id = document.getElementById('op-charge').value;
    const r = await api(`/api/owner-charges/${id}/pay`, 'POST', {
        amount: parseMoney(document.getElementById('op-amount').value), method: document.getElementById('op-method').value,
        paid_on: document.getElementById('op-date').value, reference_no: document.getElementById('op-ref').value
    });
    if (r.ok) { closeModal('modal-owner-pay'); loadSvcOwners(); } else alert(r.data.error || 'Failed');
}
let ownersData = [];
function orgOn() { return hasFeature('org') && role() !== 'SUPER_ADMIN'; }
function applyOrgOnly() { document.querySelectorAll('.org-only').forEach(el => el.style.display = orgOn() ? '' : 'none'); }
function companyLabel() { const u = currentUserInfo(); return (u.company && u.company.company_name) || u.company_name || 'Company'; }
async function loadOwners() {
    if (!orgOn()) return;
    const r = await api('/api/owners'); if (r.ok) ownersData = r.data;
    fillOwnerSelects();
}
// keepEmpty: bulk modal has a "No change" first option
function fillOwnerSelects(bulk) {
    applyOrgOnly();
    const opts = (bulk ? '<option value="">No change</option>' : '') +
        `<option value="${bulk ? 'COMPANY' : ''}">${esc(companyLabel())} (developer)</option>` +
        ownersData.map(o => `<option value="${o.owner_id}">${esc(o.full_name)}</option>`).join('') +
        '<option value="__NEW__">+ New owner...</option>';
    document.querySelectorAll('select.owner-select').forEach(sel => {
        const keep = sel.value; const isBulk = sel.id === 'bk-owner';
        sel.innerHTML = isBulk ? opts : opts.replace('<option value="">No change</option>', '').replace('value="COMPANY"', 'value=""');
        if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    });
}
async function onOwnerSelect(sel) {
    if (sel.value !== '__NEW__') return;
    const name = (prompt('Owner full name') || '').trim();
    if (!name) { sel.value = ''; return; }
    const phone = (prompt('Owner phone (optional)') || '').trim();
    const r = await api('/api/owners', 'POST', { full_name: name, phone_number: phone });
    if (!r.ok) { alert(r.data.error || 'Failed'); sel.value = ''; return; }
    await loadOwners();
    sel.value = r.data.owner_id || (ownersData.find(o => o.full_name === name) || {}).owner_id || '';
}
async function manageOwners() {
    await loadOwners();
    const r = ownersData;
    const lines = r.map(o => `${o.owner_id}: ${o.full_name}${o.phone_number ? ' (' + o.phone_number + ')' : ''}`).join('\n') || '-';
    const act = (prompt('Owners:\n' + lines + '\n\nType a number to rename that owner, or type NEW to add one.') || '').trim();
    if (!act) return;
    if (act.toUpperCase() === 'NEW') { const sel = { value: '__NEW__' }; await onOwnerSelect(sel); }
    else {
        const o = r.find(x => String(x.owner_id) === act); if (!o) return alert('Owner not found.');
        const name = (prompt('Owner name', o.full_name) || '').trim(); if (!name) return;
        const phone = (prompt('Owner phone', o.phone_number || '') || '').trim();
        const x = await api('/api/owners/' + o.owner_id, 'PUT', { full_name: name, phone_number: phone });
        if (!x.ok) return alert(x.data.error || 'Failed'); await loadOwners();
    }
    if (currentPage === 'svcowners') loadSvcOwners();
}
async function removeOwner(id) {
    if (!confirm('Delete this owner?')) return;
    const r = await api('/api/owners/' + id, 'DELETE');
    if (!r.ok) return alert(r.data.error || 'Failed');
    await loadOwners(); loadSvcOwners();
}
function initSvcYear() {
    const sel = document.getElementById('so-year'); if (sel.options.length) return;
    const y = new Date().getFullYear();
    for (let i = y; i >= y - 3; i--) sel.insertAdjacentHTML('beforeend', `<option value="${i}">${i}</option>`);
}
const SO_STATE = { TENANT: ['Rented', 'text-emerald-300 bg-emerald-900/30'], VACANT: ['Vacant', 'text-amber-300 bg-amber-900/30'], OWNER_LIVES: ['Owner lives here', 'text-blue-300 bg-blue-900/30'] };
async function loadSvcOwners() {
    if (!orgOn()) return;
    initSvcYear();
    await loadOwners();
    const yr = document.getElementById('so-year').value || new Date().getFullYear();
    const box = document.getElementById('so-list');
    const r = await api('/api/service-owners?year=' + yr);
    if (!r.ok) { box.innerHTML = `<div class="text-xs text-rose-300">${esc(r.data.error || 'Failed')}</div>`; return; }
    const list = r.data.owners || [];
    if (!list.length) { box.innerHTML = '<div class="text-xs text-gray-500 p-4">No units yet.</div>'; return; }
    const cur = (t) => ['TZS', 'USD'].filter(c => t[c] && (t[c].recorded || t[c].not_recorded || t[c].invoiced || t[c].paid || t[c].owed));
    const stat = (label, v, cls) => `<div class="p-2.5 rounded-xl bg-[#0d172d] border border-[#182848]"><div class="text-[10px] uppercase text-gray-500"><span>${label}</span></div><div class="text-xs font-black ${cls || 'text-white'}">${v}</div></div>`;
    box.innerHTML = list.map(o => {
        const name = o.owner_id ? o.owner_name : companyLabel();
        const c = o.counts || {};
        const tot = cur(o.totals || {}).map(k => { const t = o.totals[k]; return `<div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-2">${stat('Expected (' + k + ')', money(t.recorded, k))}${stat('Not recorded', money(t.not_recorded, k), 'text-gray-400')}${stat('Invoiced', money(t.invoiced, k))}${stat('Collected', money(t.paid, k), 'text-emerald-400')}${stat('Owed', money(t.owed, k), t.owed > 0 ? 'text-rose-400' : 'text-gray-300')}</div>`; }).join('');
        const rows = o.units.map(u => {
            const st = SO_STATE[u.state] || SO_STATE.VACANT;
            const who = u.state === 'TENANT' && u.tenant_name ? ` · ${esc(u.tenant_name)}` : '';
            SO_UNITS[u.unit_id] = u;
            let note = u.state === 'VACANT' ? (o.owner_id ? 'Not recorded' : 'Company cost (info)') : (u.inclusive ? 'Included in rent' : (u.owed > 0 ? 'Owes ' + money(u.owed, u.invoice_currency || u.currency) : 'Up to date'));
            if (u.state === 'OWNER_LIVES') {
                if (!(u.charges || []).length) note = '<span class="text-amber-300">Not billed yet</span>';
                else if (u.owed > 0) note += ` <button onclick="openOwnerPay(${u.unit_id})" class="can-money ml-1 px-2 py-0.5 rounded bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-bold">Receive</button>`;
            }
            return `<tr class="border-t border-[#182848]"><td class="py-1.5 pr-2 text-white">${esc(u.property_name)} · ${esc(u.unit_number)}<span class="text-gray-500">${who}</span></td><td class="py-1.5 pr-2 whitespace-nowrap">${money(u.service_charge, u.currency)}</td><td class="py-1.5 pr-2"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${st[1]}">${st[0]}</span></td><td class="py-1.5 text-right whitespace-nowrap ${u.owed > 0 ? 'text-rose-300' : 'text-gray-400'}">${note}</td></tr>`;
        }).join('');
        return `<div class="bg-[#0d172d] border border-[#182848] rounded-2xl p-4 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2"><div><div class="text-sm font-black text-white">${esc(name)}</div><div class="text-[11px] text-gray-500">${o.owner_id ? esc(o.owner_phone || '') : '<span>Developer / company</span>'}</div></div>
            <div class="flex items-center gap-2 text-[10px] font-bold"><span class="px-2 py-1 rounded-full bg-emerald-900/30 text-emerald-300">${c.let || 0} <span>rented</span></span><span class="px-2 py-1 rounded-full bg-amber-900/30 text-amber-300">${c.vacant || 0} <span>vacant</span></span><span class="px-2 py-1 rounded-full bg-blue-900/30 text-blue-300">${c.lives || 0} <span>lives</span></span>${o.owner_id ? `<button onclick="removeOwner(${o.owner_id})" class="can-manage text-rose-400 px-2"><i class="fa-solid fa-trash"></i></button>` : ''}</div></div>
            ${tot}
            <div class="overflow-x-auto"><table class="w-full text-[11px] text-gray-300"><thead><tr class="text-gray-500 text-left"><th class="pb-1"><span>Unit</span></th><th class="pb-1"><span>Service charge</span></th><th class="pb-1"><span>State</span></th><th class="pb-1 text-right"><span>Status</span></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }).join('');
    applyRoleUI();
}

// ============================================================
// PROPERTIES & UNITS
// ============================================================
let propertiesData = [];
const expandedProps = new Set();
const SVC_BADGE = {
    PAID: ['Paid', 'bg-emerald-900/40 text-emerald-300 border-emerald-500/30'], PARTIAL: ['Partial', 'bg-amber-900/40 text-amber-300 border-amber-500/30'],
    UNPAID: ['Unpaid', 'bg-rose-900/40 text-rose-300 border-rose-500/30'], NOT_BILLED: ['Not billed', 'bg-orange-900/40 text-orange-300 border-orange-500/30'],
    INCLUSIVE: ['Inclusive', 'bg-sky-900/40 text-sky-300 border-sky-500/30']
};
function svcBadge(st) { const b = SVC_BADGE[st]; return b ? `<span class="px-2 py-0.5 rounded text-[10px] border ${b[1]}">${b[0]}</span>` : '<span class="text-gray-600">-</span>'; }

async function loadProperties() {
    const r = await api('/api/properties/overview');
    if (!r.ok) return;
    propertiesData = r.data;
    renderProperties();
}

function renderProperties() {
    const box = document.getElementById('properties-list'); if (!box) return;
    const q = (document.getElementById('prop-search')?.value || '').toLowerCase().trim();
    const all = propertiesData;
    const tot = all.reduce((a, p) => ({ u: a.u + p.units_count, o: a.o + p.occupied, v: a.v + p.vacant, s: a.s + p.service_unpaid }), { u: 0, o: 0, v: 0, s: 0 });
    document.getElementById('prop-summary').innerHTML = [
        ['Properties', all.length, 'text-blue-400'], ['Total units', tot.u, 'text-white'], ['Occupied', tot.o, 'text-emerald-400'], ['Vacant', tot.v, 'text-amber-400']
    ].map(x => `<div class="p-3 bg-[#0d172d] border border-[#182848] rounded-xl"><div class="text-[10px] text-gray-400 uppercase">${x[0]}</div><div class="text-xl font-black ${x[2]}">${x[1]}</div></div>`).join('');
    if (all.length === 0) { box.innerHTML = '<div class="p-8 text-center text-gray-500 text-xs">No properties yet. Press <b>+ Property</b> to add your first one.</div>'; return; }

    const list = all.filter(p => !q || [p.property_name, p.address, p.category].some(v => String(v || '').toLowerCase().includes(q)) || p.units.some(u => String(u.unit_number).toLowerCase().includes(q) || String(u.tenant_name || '').toLowerCase().includes(q)));
    const mg = canManage();
    box.innerHTML = list.map(p => {
        const open = expandedProps.has(p.property_id) || (q && p.units.some(u => String(u.unit_number).toLowerCase().includes(q) || String(u.tenant_name || '').toLowerCase().includes(q)));
        const rows = p.units.map(u => `
            <tr class="hover:bg-[#14223d]/50">
                ${mg ? `<td class="p-2.5 w-8"><input type="checkbox" ${selUnits.has(Number(u.unit_id)) ? 'checked' : ''} onchange="toggleUnitSel(${Number(u.unit_id)}, this.checked)"></td>` : ''}
                <td class="p-2.5 font-bold text-white">${esc(u.unit_number)}</td>
                <td class="p-2.5">${money(u.rent_amount)}</td>
                <td class="p-2.5">${u.service_inclusive ? '<span class="text-sky-300">Inclusive</span>' : (Number(u.service_charge) > 0 ? money(u.service_charge) : '<span class="text-gray-600">-</span>')}</td>
                <td class="p-2.5">${u.status === 'OCCUPIED' ? '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-900/40 text-emerald-300 border border-emerald-500/30">Occupied</span>' : (u.status === 'VACANT' ? '<span class="px-2 py-0.5 rounded text-[10px] bg-amber-900/40 text-amber-300 border border-amber-500/30">Vacant</span>' : '<span class="px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-300 border border-gray-600/40">Maintenance</span>')}</td>
                <td class="p-2.5">${u.tenant_name ? `<span class="text-cyan-300 font-semibold">${esc(u.tenant_name)}</span>` : '<span class="text-gray-600">-</span>'}</td>
                <td class="p-2.5">${svcBadge(u.service_status)}</td>
                <td class="p-2.5 whitespace-nowrap text-right">
                    ${u.tenant_phone ? contactBtns(u.tenant_phone, '', true) : ''}
                    ${mg ? `<button onclick="openUnitEdit(${Number(u.unit_id)})" class="w-7 h-7 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40 hover:bg-amber-600 hover:text-white" title="Edit"><i class="fa-solid fa-pen text-[10px]"></i></button>` : ''}
                    ${mg && u.status !== 'OCCUPIED' ? `<button onclick="deleteUnit(${Number(u.unit_id)})" class="w-7 h-7 rounded-lg bg-red-600/20 text-red-300 border border-red-500/40 hover:bg-red-600 hover:text-white" title="Delete"><i class="fa-solid fa-trash-can text-[10px]"></i></button>` : ''}
                </td>
            </tr>`).join('');
        return `
        <div class="bg-[#0d172d] border border-[#182848] rounded-2xl overflow-hidden">
            <div class="p-4 flex flex-wrap items-center justify-between gap-3 cursor-pointer" onclick="toggleProp(${Number(p.property_id)})">
                <div class="min-w-0">
                    <div class="font-black text-white flex items-center gap-2">${isAdminRole() ? `<input type="checkbox" ${selProps.has(Number(p.property_id)) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="togglePropSel(${Number(p.property_id)}, this.checked)">` : ''}<i class="fa-solid fa-chevron-${open ? 'down' : 'right'} text-[10px] text-gray-500 w-3"></i>${esc(p.property_name)}
                        <span class="px-2 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-300 border border-blue-500/30 font-normal">${esc(p.category)}</span></div>
                    <div class="text-[11px] text-gray-500 ml-5">${esc(p.address || '')}</div>
                </div>
                <div class="flex items-center gap-4 text-xs">
                    <div class="text-center"><div class="font-black text-white">${p.units_count}</div><div class="text-[10px] text-gray-500">units</div></div>
                    <div class="text-center"><div class="font-black text-emerald-400">${p.occupied}</div><div class="text-[10px] text-gray-500">occupied</div></div>
                    <div class="text-center"><div class="font-black text-amber-400">${p.vacant}</div><div class="text-[10px] text-gray-500">vacant</div></div>
                    <div class="text-center" title="${esc(p.service_charge_label)} not fully paid this month"><div class="font-black ${p.service_unpaid ? 'text-rose-400' : 'text-gray-500'}">${p.service_unpaid}</div><div class="text-[10px] text-gray-500">${esc(p.service_charge_label)} unpaid</div></div>
                </div>
            </div>
            ${open ? `
            <div class="border-t border-[#182848]">
                ${mg ? `<div class="p-3 flex flex-wrap gap-2 bg-[#0a1224] text-xs">
                    <button onclick="openAddUnits(${Number(p.property_id)})" class="px-3 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-700 text-white font-bold"><i class="fa-solid fa-plus"></i> Add Units</button>
                    <button onclick="openBulk(${Number(p.property_id)})" class="px-3 py-2 rounded-xl bg-[#14223d] border border-[#233863] text-gray-200 font-bold"><i class="fa-solid fa-tags"></i> Change Prices Together</button>
                    <button onclick="openPropertyEdit(${Number(p.property_id)})" class="px-3 py-2 rounded-xl bg-amber-600/30 text-amber-300 border border-amber-500/50 font-bold"><i class="fa-solid fa-pen"></i> Edit Property</button>
                    ${isAdminRole() ? `<button onclick="deleteProperty(${Number(p.property_id)})" class="px-3 py-2 rounded-xl bg-red-600/20 text-red-300 border border-red-500/40 font-bold"><i class="fa-solid fa-trash-can"></i> Delete</button>` : ''}
                </div>` : ''}
                <div class="overflow-x-auto"><table class="w-full text-left text-xs text-gray-300">
                    <thead class="bg-[#14223d] text-gray-400 uppercase font-bold"><tr>${mg ? '<th class="p-2.5 w-8"></th>' : ''}<th class="p-2.5"><span>${unitNoLabel(p.category)}</span></th><th class="p-2.5">Rent</th><th class="p-2.5">${esc(p.service_charge_label)}</th><th class="p-2.5">Status</th><th class="p-2.5">Tenant</th><th class="p-2.5">${esc(p.service_charge_label)} (this month)</th><th class="p-2.5"></th></tr></thead>
                    <tbody class="divide-y divide-[#182848]">${rows || '<tr><td colspan="8" class="p-4 text-center text-gray-500">No units yet.</td></tr>'}</tbody>
                </table></div>
            </div>` : ''}
        </div>`;
    }).join('') || '<div class="p-6 text-center text-gray-500 text-xs">Nothing matches your search.</div>';
    updatePropBulk();
}
function toggleProp(id) { if (expandedProps.has(id)) expandedProps.delete(id); else expandedProps.add(id); renderProperties(); }
function findProp(id) { return propertiesData.find(p => Number(p.property_id) === Number(id)); }
function findUnit(id) { for (const p of propertiesData) { const u = p.units.find(x => Number(x.unit_id) === Number(id)); if (u) return { u, p }; } return null; }

function openPropertyEdit(id) {
    const p = findProp(id); if (!p) return;
    document.getElementById('pe-id').value = p.property_id; document.getElementById('pe-name').value = p.property_name || '';
    document.getElementById('pe-address').value = p.address || ''; document.getElementById('pe-label').value = p.service_charge_label || '';
    openModal('modal-property-edit');
}
async function saveProperty(e) {
    e.preventDefault();
    const id = document.getElementById('pe-id').value;
    const r = await api(`/api/properties/${id}`, 'PUT', { property_name: document.getElementById('pe-name').value, address: document.getElementById('pe-address').value || '-', service_charge_label: document.getElementById('pe-label').value });
    if (r.ok) { closeModal('modal-property-edit'); loadAllData(); } else alert(r.data.error || 'Failed');
}
function openUnitEdit(id) {
    const f = findUnit(id); if (!f) return; const u = f.u;
    document.getElementById('ue-id').value = u.unit_id; document.getElementById('ue-title').innerText = `Edit Unit · ${f.p.property_name}`;
    document.getElementById('ue-name').value = u.unit_number; document.getElementById('ue-rent').value = formatMoney(u.rent_amount);
    document.getElementById('ue-svc').value = formatMoney(u.service_charge); document.getElementById('ue-incl').checked = !!u.service_inclusive;
    document.getElementById('ue-status').value = u.status === 'UNDER_MAINTENANCE' ? 'UNDER_MAINTENANCE' : 'VACANT';
    document.getElementById('ue-status-wrap').style.display = u.status === 'OCCUPIED' ? 'none' : '';
    fillOwnerSelects(); document.getElementById('ue-svccur').value = u.service_currency || ''; document.getElementById('ue-owner').value = u.owner_id || ''; document.getElementById('ue-occ').value = u.occupancy_type || 'LET';
    openModal('modal-unit-edit');
}
async function saveUnit(e) {
    e.preventDefault();
    const id = document.getElementById('ue-id').value;
    const r = await api(`/api/units/${id}`, 'PUT', {
        unit_number: document.getElementById('ue-name').value, rent_amount: parseMoney(document.getElementById('ue-rent').value),
        service_charge: parseMoney(document.getElementById('ue-svc').value), service_inclusive: document.getElementById('ue-incl').checked,
        status: document.getElementById('ue-status').value,
        service_currency: document.getElementById('ue-svccur').value,
        ...(orgOn() ? { owner_id: document.getElementById('ue-owner').value || 'COMPANY', occupancy_type: document.getElementById('ue-occ').value } : {})
    });
    if (r.ok) { closeModal('modal-unit-edit'); loadAllData(); } else alert(r.data.error || 'Failed');
}
function openAddUnits(pid) {
    const p = findProp(pid); if (!p) return;
    document.getElementById('au-id').value = pid; document.getElementById('au-prop').innerText = p.property_name;
    document.getElementById('au-lbl').innerText = unitNoLabel(p.category);
    ['au-name', 'au-rent', 'au-svc'].forEach(i => document.getElementById(i).value = '');
    document.getElementById('au-count').value = 1; document.getElementById('au-incl').checked = false;
    fillOwnerSelects(); document.getElementById('au-svccur').value = ''; document.getElementById('au-owner').value = ''; document.getElementById('au-occ').value = 'LET';
    openModal('modal-add-units');
}
async function addUnits(e) {
    e.preventDefault();
    const id = document.getElementById('au-id').value;
    const r = await api(`/api/properties/${id}/units`, 'POST', {
        unit_number: document.getElementById('au-name').value, count: parseInt(document.getElementById('au-count').value) || 1,
        rent_amount: parseMoney(document.getElementById('au-rent').value), service_charge: parseMoney(document.getElementById('au-svc').value),
        service_inclusive: document.getElementById('au-incl').checked,
        service_currency: document.getElementById('au-svccur').value,
        ...(orgOn() ? { owner_id: document.getElementById('au-owner').value || 'COMPANY', occupancy_type: document.getElementById('au-occ').value } : {})
    });
    if (r.ok) { closeModal('modal-add-units'); expandedProps.add(Number(id)); loadAllData(); } else alert(r.data.error || 'Failed');
}
function openBulk(pid) {
    const p = findProp(pid); if (!p) return;
    document.getElementById('bk-id').value = pid; document.getElementById('bk-prop').innerText = p.property_name;
    ['bk-rent', 'bk-svc'].forEach(i => document.getElementById(i).value = ''); document.getElementById('bk-incl').value = ''; document.getElementById('bk-scope').value = 'VACANT';
    fillOwnerSelects(true); ['bk-svccur', 'bk-owner', 'bk-occ'].forEach(i => document.getElementById(i).value = '');
    openModal('modal-bulk');
}
async function saveBulk(e) {
    e.preventDefault();
    const id = document.getElementById('bk-id').value;
    const body = { scope: document.getElementById('bk-scope').value };
    const rent = parseMoney(document.getElementById('bk-rent').value), svc = parseMoney(document.getElementById('bk-svc').value), inc = document.getElementById('bk-incl').value;
    if (document.getElementById('bk-rent').value.trim()) body.rent_amount = rent;
    if (document.getElementById('bk-svc').value.trim()) body.service_charge = svc;
    if (inc !== '') body.service_inclusive = inc === 'true';
    const bsc = document.getElementById('bk-svccur').value; if (bsc) body.service_currency = bsc === 'SAME' ? '' : bsc;
    if (orgOn()) { const bo = document.getElementById('bk-owner').value, bq = document.getElementById('bk-occ').value; if (bo) body.owner_id = bo === 'COMPANY' ? 'COMPANY' : bo; if (bq) body.occupancy_type = bq; }
    if (Object.keys(body).length === 1) return alert('Enter at least one new price.');
    const r = await api(`/api/properties/${id}/bulk-units`, 'PUT', body);
    if (r.ok) { closeModal('modal-bulk'); loadAllData(); alert(r.data.message || 'Updated.'); } else alert(r.data.error || 'Failed');
}

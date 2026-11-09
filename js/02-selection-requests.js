// ============================================================
// SELECT, EDIT AND DELETE (tenants, units, properties) + EDIT REQUESTS
// ============================================================
let selTenants = new Set(), selProps = new Set(), selUnits = new Set(), renderedTenantIds = [], delJob = null, editCtx = { tenantId: null, requestId: null };

function bulkBtn(label, cls, fn) { return `<button onclick="${fn}" class="px-3 py-1.5 rounded-lg font-bold border ${cls}">${label}</button>`; }
function toggleTenantSel(id, on) { if (on) selTenants.add(Number(id)); else selTenants.delete(Number(id)); updateTenantBulk(); }
function toggleAllTenants(on) { renderedTenantIds.forEach(id => on ? selTenants.add(id) : selTenants.delete(id)); renderTenantsTable(currentTenantsList.filter(t => renderedTenantIds.includes(Number(t.tenant_id)))); }
function clearTenantSel() { selTenants.clear(); applyTenantFilters(); }
function updateTenantBulk() {
    const box = document.getElementById('ten-bulk'); if (!box) return;
    const n = selTenants.size;
    const all = document.getElementById('ten-sel-all'); if (all) all.checked = renderedTenantIds.length > 0 && renderedTenantIds.every(id => selTenants.has(id));
    document.querySelectorAll('.sel-col').forEach(el => el.style.display = canManageLeases() ? '' : 'none');
    if (!n) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = `<span class="font-bold text-white">${n} selected</span>` +
        (n === 1 && canManageLeases() ? bulkBtn('<i class="fa-solid fa-pen"></i> Edit', 'bg-amber-600/30 text-amber-300 border-amber-500/50', `openEditChoose(${[...selTenants][0]})`) : '') +
        (canDeleteTenants() ? bulkBtn('<i class="fa-solid fa-trash-can"></i> Delete', 'bg-red-600/20 text-red-300 border-red-500/40', 'deleteSelectedTenants()') : '') +
        bulkBtn('Clear', 'bg-[#14223d] text-gray-300 border-[#233863]', 'clearTenantSel()');
}
function deleteSelectedTenants() {
    const ids = [...selTenants]; if (!ids.length) return;
    askDelete({ title: 'Delete tenants', text: `Delete ${ids.length} selected tenant(s)? A tenant who already paid cannot be deleted, unless you also delete the history below. Use "Move Out" to keep the history.`, allowForce: true,
        run: (force) => api('/api/tenants/bulk-delete', 'POST', { ids, force: force, confirm: force ? 'DELETE' : '' }), done: () => selTenants.clear() });
}
function deleteTenant(tenantId) {
    askDelete({ title: 'Delete tenant', text: 'Delete this tenant? A tenant who already paid cannot be deleted, unless you also delete the history below. Use "Move Out" to keep the history.', allowForce: true,
        run: (force) => api('/api/tenants/bulk-delete', 'POST', { ids: [Number(tenantId)], force: force, confirm: force ? 'DELETE' : '' }), done: () => { selTenants.delete(Number(tenantId)); closeModal('modal-tenant-detail'); } });
}

// one delete window for everything
function askDelete(job) {
    delJob = job;
    document.getElementById('del-title').innerHTML = '<i class="fa-solid fa-trash-can text-red-400"></i> ' + esc(job.title);
    document.getElementById('del-text').textContent = job.text;
    const fw = document.getElementById('del-force-wrap');
    fw.classList.toggle('hidden', !(job.allowForce && isAdminRole()));
    document.getElementById('del-force').checked = false; document.getElementById('del-type').value = ''; document.getElementById('del-type-wrap').classList.add('hidden');
    document.getElementById('del-go').disabled = false;
    openModal('modal-del');
}
async function runDelete() {
    if (!delJob) return;
    const force = document.getElementById('del-force').checked && !document.getElementById('del-force-wrap').classList.contains('hidden');
    if (force && document.getElementById('del-type').value.trim() !== 'DELETE') return alert('Type DELETE to confirm.');
    const btn = document.getElementById('del-go'); btn.disabled = true;
    const r = await delJob.run(force);
    btn.disabled = false;
    const nothingDone = r.ok && r.data && r.data.failed && r.data.failed.length && !r.data.deleted;
    if (!r.ok || nothingDone) {
        const err = nothingDone ? r.data.failed[0].error : (r.data.error || 'Failed');
        // refused because of history: let an owner/admin go on with "delete with history" in the same window
        if (delJob.allowForce && isAdminRole() && !force && /history|payment records|has a tenant|ticket/i.test(err)) {
            document.getElementById('del-text').textContent = err + '  ' + 'To delete it together with its history, type DELETE below and press Delete again.';
            document.getElementById('del-force').checked = true; document.getElementById('del-type-wrap').classList.remove('hidden');
            document.getElementById('del-type').focus(); return;
        }
        return alert(err);
    }
    let msg = r.data.message || 'Done.';
    if (r.data.failed && r.data.failed.length) msg += '\n\n' + r.data.failed.slice(0, 5).map(f => '• ' + f.error).join('\n');
    closeModal('modal-del');
    if (delJob.done) delJob.done();
    alert(msg); loadAllData();
}

// ---- properties and units: select ----
function togglePropSel(id, on) { if (on) selProps.add(Number(id)); else selProps.delete(Number(id)); updatePropBulk(); }
function toggleUnitSel(id, on) { if (on) selUnits.add(Number(id)); else selUnits.delete(Number(id)); updatePropBulk(); }
function clearPropSel() { selProps.clear(); selUnits.clear(); renderProperties(); }
function updatePropBulk() {
    const box = document.getElementById('prop-bulk'); if (!box) return;
    const np = selProps.size, nu = selUnits.size;
    if (!np && !nu) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const parts = [];
    if (np) parts.push(`${np} propert${np === 1 ? 'y' : 'ies'}`); if (nu) parts.push(`${nu} unit${nu === 1 ? '' : 's'}`);
    let h = `<span class="font-bold text-white">${parts.join(' + ')} selected</span>`;
    if (np === 1 && !nu && canManage()) h += bulkBtn('<i class="fa-solid fa-pen"></i> Edit property', 'bg-amber-600/30 text-amber-300 border-amber-500/50', `openPropertyEdit(${[...selProps][0]})`);
    if (nu === 1 && !np && canManage()) h += bulkBtn('<i class="fa-solid fa-pen"></i> Edit unit', 'bg-amber-600/30 text-amber-300 border-amber-500/50', `openUnitEdit(${[...selUnits][0]})`);
    if (nu && canManage()) h += bulkBtn('<i class="fa-solid fa-trash-can"></i> Delete units only', 'bg-red-600/20 text-red-300 border-red-500/40', 'deleteSelectedUnits()');
    if (np && isAdminRole()) h += bulkBtn('<i class="fa-solid fa-trash-can"></i> Delete whole property', 'bg-red-600/20 text-red-300 border-red-500/40', 'deleteSelectedProps()');
    h += bulkBtn('Clear', 'bg-[#14223d] text-gray-300 border-[#233863]', 'clearPropSel()');
    box.innerHTML = h;
}
function deleteSelectedUnits() {
    const ids = [...selUnits]; if (!ids.length) return;
    askDelete({ title: 'Delete units', text: `Delete ${ids.length} selected unit(s) only? The property stays. A unit with a tenant or history cannot be deleted, unless you also delete the history below.`, allowForce: true,
        run: (force) => api('/api/units/bulk-delete', 'POST', { ids, force, confirm: force ? 'DELETE' : '' }), done: () => selUnits.clear() });
}
function deleteSelectedProps() {
    const ids = [...selProps]; if (!ids.length) return;
    const names = ids.map(i => (findProp(i) || {}).property_name).filter(Boolean).join(', ');
    askDelete({ title: 'Delete whole property', text: `Delete ${names} with all its units? A property with tenant history cannot be deleted, unless you also delete the history below.`, allowForce: true,
        run: (force) => api('/api/properties/bulk-delete', 'POST', { ids, force, confirm: force ? 'DELETE' : '' }), done: () => { selProps.clear(); selUnits.clear(); } });
}
function deleteProperty(id) { selProps = new Set([Number(id)]); selUnits.clear(); deleteSelectedProps(); }
function deleteUnit(id) { selUnits = new Set([Number(id)]); selProps.clear(); deleteSelectedUnits(); }

// ---- editing saved tenants: owner/admin edits directly, staff ask permission first ----
function findTenant(id) { return currentTenantsList.find(x => String(x.tenant_id) === String(id)); }
function openEditChoose(tenantId) {
    const t = findTenant(tenantId); if (!t) return;
    editCtx = { tenantId: Number(tenantId), requestId: null };
    document.getElementById('ec-who').textContent = `${t.full_name} · ${t.property_name} (${t.unit_number})`;
    document.getElementById('ec-note').textContent = isAdminRole() ? 'You can edit directly.' : 'Choose the part you made a mistake in. If the owner/admin has not allowed it yet, you will ask for permission.';
    closeModal('modal-tenant-detail'); openModal('modal-edit-choose');
}
async function startEdit(section) {
    const id = editCtx.tenantId; if (!id) return;
    closeModal('modal-edit-choose');
    if (isAdminRole() || (section === 'TENANT_INFO' && currentUserInfo().can_edit_tenants)) return openEditSection(id, section, null);
    const r = await api('/api/edit-requests');
    const ok = ((r.data && r.data.requests) || []).find(x => x.usable && Number(x.entity_id) === Number(id) && x.section === section);
    if (ok) return openEditSection(id, section, ok.request_id);
    openRequestModal(id, section);
}
function openEditSection(tenantId, section, requestId) {
    editCtx = { tenantId: Number(tenantId), requestId: requestId || null };
    if (section === 'TENANT_INFO') openEditTenant(tenantId);
    else openLeaseEdit(tenantId);
}
function openRequestModal(tenantId, section) {
    const t = findTenant(tenantId); if (!t) return;
    document.getElementById('er-who').textContent = `${t.full_name} · ${t.property_name} (${t.unit_number})`;
    document.getElementById('er-section').value = section || 'TENANT_INFO'; document.getElementById('er-reason').value = '';
    editCtx.tenantId = Number(tenantId);
    openModal('modal-edit-request');
}
async function sendEditRequest(e) {
    e.preventDefault();
    const r = await api('/api/edit-requests', 'POST', { tenant_id: editCtx.tenantId, section: document.getElementById('er-section').value, reason: document.getElementById('er-reason').value });
    if (!r.ok) return alert(r.data.error || 'Failed');
    closeModal('modal-edit-request'); alert(r.data.message || 'Request sent.'); refreshRequestBadge();
}
function needsApproval(res) {
    if (res && res.code === 'NEEDS_APPROVAL') { alert(res.error); return true; } return false;
}
function openLeaseEdit(tenantId) {
    const t = findTenant(tenantId); if (!t) return;
    document.getElementById('le-who').textContent = `${t.full_name} · ${t.property_name} (${t.unit_number})`;
    document.getElementById('le-lease-id').value = t.lease_id;
    document.getElementById('le-price').value = formatMoney(t.rent_price || 0);
    document.getElementById('le-periods').value = Number(t.number_of_periods) || 1;
    document.getElementById('le-discount').value = formatMoney(t.discount || 0);
    document.getElementById('le-start').value = dateOnly(t.start_date); document.getElementById('le-end').value = dateOnly(t.end_date);
    editCtx.paid = Number(t.amount_paid) || 0; leCalc();
    openModal('modal-lease-edit');
}
function leCalc() {
    const price = parseMoney(document.getElementById('le-price').value), per = parseFloat(document.getElementById('le-periods').value) || 0, disc = parseMoney(document.getElementById('le-discount').value);
    const total = Math.max(0, Math.round(price * per) - disc), paid = editCtx.paid || 0;
    document.getElementById('le-sum').innerHTML = `Total to pay: <b class="text-white">${money(total)}</b> · Already paid: <b class="text-emerald-400">${money(paid)}</b> · Balance: <b class="${total - paid > 0 ? 'text-rose-400' : 'text-gray-300'}">${money(Math.max(0, total - paid))}</b>`;
}
async function saveLeaseEdit(e) {
    e.preventDefault();
    const id = document.getElementById('le-lease-id').value;
    const r = await api(`/api/leases/${id}/correct`, 'PUT', {
        rent_price: parseMoney(document.getElementById('le-price').value), number_of_periods: document.getElementById('le-periods').value,
        discount: parseMoney(document.getElementById('le-discount').value), start_date: document.getElementById('le-start').value, end_date: document.getElementById('le-end').value,
        request_id: editCtx.requestId || undefined });
    if (r.ok) { closeModal('modal-lease-edit'); loadAllData(); alert(r.data.message || 'Saved.'); refreshRequestBadge(); }
    else if (!needsApproval(r.data)) alert(r.data.error || 'Failed');
}

// ---- the Edit Requests page ----
async function refreshRequestBadge() {
    if (!['COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'].includes(role())) return;
    const r = await api('/api/edit-requests/summary'); const n = r.ok ? Number(r.data.count) || 0 : 0;
    const b = document.getElementById('nav-badge-requests'); if (!b) return;
    b.textContent = n; b.classList.toggle('hidden', n === 0);
}
const REQ_STATUS = { PENDING: ['Waiting', 'bg-amber-900/40 text-amber-300 border-amber-500/30'], APPROVED: ['Allowed', 'bg-emerald-900/40 text-emerald-300 border-emerald-500/30'], REJECTED: ['Refused', 'bg-red-900/40 text-red-300 border-red-500/30'], USED: ['Used', 'bg-gray-800 text-gray-300 border-gray-600/40'], CANCELLED: ['Cancelled', 'bg-gray-800 text-gray-300 border-gray-600/40'] };
async function loadRequests() {
    const box = document.getElementById('requests-list'); if (!box) return;
    document.getElementById('req-help').textContent = isAdminRole() ? 'Staff ask here when they want to change something that was already saved. Allow or refuse. An allowed edit works once, within 24 hours.' : 'Ask permission here when you made a mistake in something already saved. After it is allowed, press Edit now.';
    const r = await api('/api/edit-requests');
    if (!r.ok) { box.innerHTML = `<div class="p-6 text-center text-rose-400 text-xs">${esc(r.data.error || 'Could not load')}</div>`; return; }
    const list = r.data.requests || [];
    if (!list.length) { box.innerHTML = '<div class="p-8 text-center text-gray-500 text-xs">No requests yet.</div>'; refreshRequestBadge(); return; }
    const admin = isAdminRole();
    box.innerHTML = list.map(q => {
        const st = REQ_STATUS[q.status] || [q.status, 'bg-gray-800 text-gray-300 border-gray-600/40'];
        const when = new Date(q.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        let actions = '';
        if (admin && q.status === 'PENDING') actions = `<input id="rq-note-${q.request_id}" class="inp !py-2 !w-48" placeholder="Note (optional)"> <button onclick="decideRequest(${q.request_id}, true)" class="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold">Allow</button> <button onclick="decideRequest(${q.request_id}, false)" class="px-3 py-2 rounded-xl bg-red-600/30 text-red-300 border border-red-500/40 font-bold">Refuse</button>`;
        if (!admin && q.usable) actions = `<button onclick="useRequest(${q.entity_id}, '${esc(q.section)}')" class="px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold"><i class="fa-solid fa-pen"></i> Edit now</button>`;
        if (!admin && ['PENDING', 'APPROVED'].includes(q.status)) actions += ` <button onclick="cancelRequest(${q.request_id})" class="px-3 py-2 rounded-xl bg-[#14223d] border border-[#233863] text-gray-300 font-bold">Cancel</button>`;
        return `<div class="p-4 bg-[#0d172d] border border-[#182848] rounded-2xl text-xs space-y-2">
            <div class="flex flex-wrap justify-between gap-2"><div><div class="font-bold text-white">${esc(q.entity_label || '')}</div><div class="text-cyan-300">${esc(q.section_label)}</div></div>
                <span class="px-2 py-0.5 rounded text-[10px] border h-fit ${st[1]}">${st[0]}</span></div>
            <div class="text-gray-300">“${esc(q.reason || '')}”</div>
            <div class="text-[10px] text-gray-500">${esc(q.requested_by_name || '')} · ${when}${q.decided_by_name ? ' · ' + esc(q.decided_by_name) : ''}${q.decision_note ? ' · ' + esc(q.decision_note) : ''}</div>
            ${actions ? `<div class="flex flex-wrap items-center gap-2 pt-1">${actions}</div>` : ''}</div>`;
    }).join('');
    refreshRequestBadge();
}
async function decideRequest(id, approve) {
    const note = (document.getElementById('rq-note-' + id) || {}).value || '';
    const r = await api(`/api/edit-requests/${id}/decision`, 'PUT', { approve, note });
    if (!r.ok) return alert(r.data.error || 'Failed');
    loadRequests();
}
async function cancelRequest(id) { const r = await api(`/api/edit-requests/${id}/cancel`, 'PUT'); if (!r.ok) alert(r.data.error || 'Failed'); loadRequests(); }
function useRequest(tenantId, section) { editCtx = { tenantId: Number(tenantId), requestId: null }; showPage('tenants'); setTimeout(() => startEdit(section), 300); }
setInterval(() => { if (document.getElementById('view-app') && document.getElementById('view-app').style.display !== 'none') refreshRequestBadge(); }, 60000);

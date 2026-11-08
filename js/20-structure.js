// ============================================================
// STRUCTURE (Pro): departments, projects, people and how each is doing
// ============================================================
let structData = null, deptData = { departments: [], suggestions: [] };
const pct = v => v === null || v === undefined ? '-' : v + '%';
function chip(text, cls) { return `<span class="px-2 py-0.5 rounded-full text-[10px] border ${cls || 'bg-[#14223d] text-gray-300 border-[#233863]'}">${esc(text)}</span>`; }
function personLine(m) {
    const where = m.all_projects ? chip('All projects', 'bg-emerald-900/30 text-emerald-300 border-emerald-500/30') : m.projects.map(x => chip(x.name, 'bg-blue-900/30 text-blue-300 border-blue-500/30')).join(' ');
    return `<div class="p-2 rounded-lg bg-[#14223d] flex flex-wrap items-center gap-2"><span class="text-white font-semibold">${esc(m.full_name)}</span>
        ${chip(ROLE_LABEL[m.role] || m.role)} ${m.job_title ? `<span class="text-[10px] text-gray-400">${esc(m.job_title)}</span>` : ''}
        ${m.can_add_staff ? chip('Can add people', 'bg-amber-900/30 text-amber-300 border-amber-500/30') : ''}
        ${m.is_active ? '' : chip('Switched off', 'bg-rose-900/30 text-rose-300 border-rose-500/30')}
        <span class="flex flex-wrap gap-1">${where}</span></div>`;
}
async function loadStructure() {
    if (!hasFeature('org')) return;
    const [r, d] = await Promise.all([api('/api/org/structure'), api('/api/org/departments')]);
    if (!r.ok) { document.getElementById('st-depts').innerHTML = `<div class="text-xs text-rose-300">${esc(r.data.error || 'Failed')}</div>`; return; }
    structData = r.data; if (d.ok) deptData = d.data;
    const t = r.data.totals;
    const card = (label, val, cls) => `<div class="p-3 rounded-xl bg-[#0d172d] border border-[#182848]"><div class="text-[10px] uppercase text-gray-500"><span>${label}</span></div><div class="text-base font-black mt-1 ${cls || 'text-white'}">${val}</div></div>`;
    document.getElementById('st-totals').innerHTML =
        card('Projects', t.projects) + card('Units', `${t.occupied}/${t.units}`) + card('Occupancy', t.units ? Math.round(t.occupied / t.units * 100) + '%' : '-') +
        card('Collected this month', money(t.collected_month), 'text-emerald-400') + card('Expenses this month', money(t.expenses_month), 'text-amber-400') +
        card('Profit this month', money(t.profit_month), t.profit_month < 0 ? 'text-rose-400' : 'text-emerald-400') + card('People', t.people);
    const admin = isAdminRole();
    const adminLine = r.data.admins.length ? `<div class="lg:col-span-2 p-3 rounded-xl bg-[#14223d]/60 border border-[#233863]"><div class="text-[11px] font-bold text-white mb-1.5"><i class="fa-solid fa-crown text-amber-400"></i> <span>Owner / Administrators</span> <span class="text-gray-500 font-normal">· <span>see everything</span></span></div><div class="space-y-1">${r.data.admins.map(personLine).join('')}</div></div>` : '';
    const depts = r.data.departments.map(dp => `
        <div class="p-3 rounded-xl bg-[#0a1224] border border-[#182848] space-y-2">
            <div class="flex items-start justify-between gap-2"><div><div class="text-sm font-black text-white">${esc(dp.name)}</div>
                <div class="text-[10px] text-gray-500"><span>${dp.count} people</span> · <span>recorded this month:</span> ${money(dp.recorded_month)} (${dp.payments_month}) · <span>expenses entered:</span> ${money(dp.expenses_month)}</div></div>
                ${admin ? `<div class="whitespace-nowrap"><button onclick="openDeptModal(${dp.department_id})" class="w-7 h-7 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40"><i class="fa-solid fa-pen text-[10px]"></i></button>
                <button onclick="deleteDept(${dp.department_id})" class="w-7 h-7 rounded-lg bg-red-600/20 text-red-300 border border-red-500/40"><i class="fa-solid fa-trash-can text-[10px]"></i></button></div>` : ''}</div>
            <div class="space-y-1">${dp.members.length ? dp.members.map(personLine).join('') : '<div class="text-[11px] text-gray-500">No people yet.</div>'}</div>
            <button onclick="openUserModal(null, ${dp.department_id})" class="text-[11px] font-bold text-emerald-300 hover:underline">+ <span>Add person here</span></button>
        </div>`).join('');
    const other = r.data.without_department.members.length ? `<div class="p-3 rounded-xl bg-[#0a1224] border border-dashed border-[#233863] space-y-1"><div class="text-sm font-black text-gray-300">No department</div>${r.data.without_department.members.map(personLine).join('')}</div>` : '';
    document.getElementById('st-depts').innerHTML = (depts || other || adminLine) ? adminLine + depts + other : '<div class="text-xs text-gray-500">No departments yet. Add one, for example Finance or Operations.</div>';
    document.getElementById('st-projects').innerHTML = r.data.projects.length ? r.data.projects.map(p => `
        <div class="p-3 rounded-xl bg-[#0a1224] border border-[#182848] space-y-2">
            <div class="flex items-start justify-between gap-2"><div><div class="text-sm font-black text-white">${esc(p.property_name)}</div><div class="text-[10px] text-gray-500">${esc(p.address || '')}</div></div>
                <button onclick="openUserModal(null, null, ${Number(p.property_id)})" class="text-[11px] font-bold text-emerald-300 hover:underline whitespace-nowrap">+ <span>Add person here</span></button></div>
            <div class="h-2 rounded-full bg-[#14223d] overflow-hidden"><div class="h-2 bg-emerald-500" style="width:${p.occupancy_rate}%"></div></div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                <div class="p-2 rounded-lg bg-[#14223d]"><div class="text-gray-500"><span>Occupancy</span></div><div class="font-black text-white">${p.occupied}/${p.units} · ${p.occupancy_rate}%</div></div>
                <div class="p-2 rounded-lg bg-[#14223d]"><div class="text-gray-500"><span>Collected this month</span></div><div class="font-black text-emerald-400">${money(p.collected_month)}</div></div>
                <div class="p-2 rounded-lg bg-[#14223d]"><div class="text-gray-500"><span>Balances owed</span></div><div class="font-black ${p.outstanding > 0 ? 'text-rose-400' : 'text-gray-300'}">${money(p.outstanding)}</div></div>
                <div class="p-2 rounded-lg bg-[#14223d]"><div class="text-gray-500"><span>Profit this month</span></div><div class="font-black ${p.profit_month < 0 ? 'text-rose-400' : 'text-emerald-400'}">${money(p.profit_month)}</div></div>
            </div>
            <div class="text-[10px] text-gray-500"><span>Expenses this month:</span> ${money(p.expenses_month)} · <span>Collection rate:</span> ${pct(p.collection_rate)} · <span>Company-wide staff:</span> ${p.company_wide_count}</div>
            <div class="space-y-1">${p.staff.length ? p.staff.map(personLine).join('') : '<div class="text-[11px] text-gray-500">No project-only staff yet.</div>'}</div>
        </div>`).join('') : '<div class="text-xs text-gray-500">No projects yet.</div>';
    loadStaff();
}

// departments
function deptName(sug) { const l = (window.KA_LANG && window.KA_LANG()) || 'en'; return sug.names[l] || sug.names.en; }
function openDeptModal(id) {
    const d = id ? deptData.departments.find(x => Number(x.department_id) === Number(id)) : null;
    document.getElementById('dp-id').value = d ? d.department_id : ''; document.getElementById('dp-title').innerText = d ? 'Edit Department' : 'Add Department';
    document.getElementById('dp-name').value = d ? d.name : ''; document.getElementById('dp-role').value = d ? d.default_role : 'PROPERTY_MANAGER';
    document.getElementById('dp-chips').innerHTML = d ? '' : (deptData.suggestions || []).map(sg => `<button type="button" onclick="pickDeptChip('${sg.key}')" class="px-3 py-1.5 rounded-full bg-indigo-600/20 border border-indigo-500/40 text-indigo-200 text-[11px] font-bold hover:bg-indigo-600 hover:text-white">${esc(deptName(sg))}</button>`).join('');
    openModal('modal-dept');
}
function pickDeptChip(key) {
    const sg = deptData.suggestions.find(x => x.key === key); if (!sg) return;
    document.getElementById('dp-name').value = deptName(sg); document.getElementById('dp-role').value = sg.role;
}
async function saveDept(e) {
    e.preventDefault();
    const id = document.getElementById('dp-id').value;
    const r = await api(id ? `/api/org/departments/${id}` : '/api/org/departments', id ? 'PUT' : 'POST', { name: document.getElementById('dp-name').value, default_role: document.getElementById('dp-role').value });
    if (r.ok) { closeModal('modal-dept'); loadStructure(); } else alert(r.data.error || 'Failed');
}
async function deleteDept(id) {
    if (!confirm('Remove this department? Its people stay in the system without a department.')) return;
    const r = await api(`/api/org/departments/${id}`, 'DELETE');
    if (r.ok) loadStructure(); else alert(r.data.error || 'Failed');
}

// people: department + projects part of the user form
function userOrgOn() { return hasFeature('org') && canTeam(); }
async function prepareUserOrg(u, presetDept, presetProject) {
    const box = document.getElementById('us-org'); box.style.display = userOrgOn() ? '' : 'none';
    if (!userOrgOn()) return;
    if (!deptData.departments.length && !structData) { const d = await api('/api/org/departments'); if (d.ok) deptData = d.data; }
    const mine = myAccess(), admin = isAdminRole();
    const depts = deptData.departments;
    const lockedDept = !admin && mine.department_id;
    document.getElementById('us-dept').innerHTML = '<option value="">No department</option>' + depts.map(x => `<option value="${x.department_id}" data-role="${esc(x.default_role)}">${esc(x.name)}</option>`).join('') + (admin ? '<option value="__new">Other: type a new department...</option>' : '');
    const dv = u ? (u.department_id || '') : (presetDept || (lockedDept ? mine.department_id : ''));
    document.getElementById('us-dept').value = String(dv); if (document.getElementById('us-dept').value !== String(dv)) document.getElementById('us-dept').value = '';
    document.getElementById('us-dept').disabled = !!lockedDept;
    document.getElementById('us-newdept-wrap').classList.add('hidden'); document.getElementById('us-newdept').value = '';
    document.getElementById('us-title-job').value = u ? (u.job_title || '') : '';
    // projects this person may be given: all for the owner, only his own for a limited manager
    const list = propertiesData.filter(p => !isScoped() || (mine.project_ids || []).map(String).includes(String(p.property_id)));
    const chosen = (u && !u.scope_all ? u.property_ids : (presetProject ? [presetProject] : [])).map(String);
    document.getElementById('us-projects').innerHTML = list.length ? list.map(p => `<label class="us-proj-row flex items-center gap-2 text-[11px] text-gray-200 p-1.5 rounded hover:bg-[#1e2f52] cursor-pointer" data-name="${esc(String(p.property_name).toLowerCase())}"><input type="checkbox" class="us-proj" value="${p.property_id}" data-name="${esc(p.property_name)}" onchange="renderProjChips()" ${chosen.includes(String(p.property_id)) ? 'checked' : ''}> ${esc(p.property_name)}</label>`).join('') : '<div class="text-[11px] text-gray-500">No projects yet.</div>';
    const some = u ? !u.scope_all : !!presetProject || isScoped();
    document.getElementById('us-scope-all').checked = !some; document.getElementById('us-scope-some').checked = some;
    document.getElementById('us-all-wrap').style.display = isScoped() ? 'none' : 'flex';
    document.getElementById('us-addstaff').checked = u ? !!u.can_add_staff : false;
    document.getElementById('us-proj-search').value = ''; filterUserProjects(); renderProjChips();
    onUserScope();
}
function onUserScope() { document.getElementById('us-projects-box').classList.toggle('hidden', !document.getElementById('us-scope-some').checked); }
function filterUserProjects() {
    const q = document.getElementById('us-proj-search').value.toLowerCase().trim();
    document.querySelectorAll('.us-proj-row').forEach(r => { r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; });
}
function pickUserProjects(on) {
    document.querySelectorAll('.us-proj-row').forEach(r => { if (r.style.display !== 'none') r.querySelector('input').checked = on; });
    renderProjChips();
}
function renderProjChips() {
    const on = [...document.querySelectorAll('.us-proj:checked')];
    document.getElementById('us-proj-chips').innerHTML = on.length ? on.map(x => `<span class="px-2 py-0.5 rounded-full text-[10px] bg-blue-900/30 text-blue-300 border border-blue-500/30">${esc(x.dataset.name)}</span>`).join('') + `<span class="text-[10px] text-gray-500 self-center">(${on.length})</span>` : '<span class="text-[10px] text-gray-500">No project chosen yet.</span>';
}
function onUserDept() {
    const sel = document.getElementById('us-dept'); const isNew = sel.value === '__new';
    document.getElementById('us-newdept-wrap').classList.toggle('hidden', !isNew);
    const opt = sel.options[sel.selectedIndex];
    if (!document.getElementById('us-id').value && opt && opt.dataset.role) document.getElementById('us-role').value = opt.dataset.role;
}
// adds the access part to the user form body; returns an error text or null
async function readUserOrg(body) {
    if (!userOrgOn()) return null;
    let dep = document.getElementById('us-dept').value;
    if (dep === '__new') {
        const nm = document.getElementById('us-newdept').value.trim();
        if (!nm) return 'Please type the department name.';
        const r = await api('/api/org/departments', 'POST', { name: nm, default_role: document.getElementById('us-role').value === 'COMPANY_ADMIN' ? 'VIEWER' : document.getElementById('us-role').value });
        if (!r.ok) return r.data.error || 'Failed';
        dep = r.data.department_id; deptData.departments.push({ department_id: dep, name: nm, default_role: document.getElementById('us-role').value });
    }
    body.department_id = dep ? Number(dep) : null;
    body.job_title = document.getElementById('us-title-job').value;
    const some = document.getElementById('us-scope-some').checked;
    body.scope_all = !some;
    body.property_ids = some ? [...document.querySelectorAll('.us-proj:checked')].map(x => Number(x.value)) : [];
    if (some && !body.property_ids.length) return 'Choose at least one project, or choose all projects.';
    body.can_add_staff = document.getElementById('us-addstaff').checked;
    return null;
}

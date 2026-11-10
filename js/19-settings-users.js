// ============================================================
// SETTINGS: company profile, users
// ============================================================
async function loadProfile() {
    const r = await api('/api/company/profile'); if (!r.ok) return;
    companyProfile = r.data; applyLogo();
    if (cpLogoPending === undefined) showLogoPreview('cp', r.data.logo_data || null);
    const set = (i, v) => { const el = document.getElementById(i); if (el) el.value = v || ''; };
    set('cp-name', r.data.company_name); set('cp-phone', r.data.phone); set('cp-email', r.data.email); set('cp-tin', r.data.tin); set('cp-address', r.data.address); set('cp-pay', r.data.payment_instructions);
    const fy = document.getElementById('cp-fy');
    if (fy && !fy.options.length) fy.innerHTML = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
    if (fy) fy.value = r.data.fy_start_month; set('cp-luku', r.data.luku_low_threshold);
}
async function saveProfile(e) {
    e.preventDefault();
    const r = await api('/api/company/profile', 'PUT', { company_name: document.getElementById('cp-name').value, phone: document.getElementById('cp-phone').value, email: document.getElementById('cp-email').value,
        tin: document.getElementById('cp-tin').value, address: document.getElementById('cp-address').value, payment_instructions: document.getElementById('cp-pay').value,
        fy_start_month: parseInt(document.getElementById('cp-fy').value), luku_low_threshold: parseInt(document.getElementById('cp-luku').value) || 0,
        ...(cpLogoPending !== undefined ? { logo_data: cpLogoPending } : {}) });
    if (r.ok) { alert('Saved.'); cpLogoPending = undefined; await loadProfile(); fyLine(); loadMe(); } else alert(r.data.error || 'Failed');
}
let usersData = [];
const ROLE_LABEL = { COMPANY_ADMIN: 'Admin', PROPERTY_MANAGER: 'Manager', ACCOUNTANT: 'Accountant', MAINTENANCE_MANAGER: 'Maintenance Manager', TECHNICIAN: 'Maintenance Manager', VIEWER: 'Viewer' };
function accessCell(s) {
    if (!hasFeature('org')) return '';
    if (s.role === 'COMPANY_ADMIN') return chip('All projects', 'bg-emerald-900/30 text-emerald-300 border-emerald-500/30');
    if (s.scope_all) return chip('All projects', 'bg-emerald-900/30 text-emerald-300 border-emerald-500/30');
    const names = (s.property_ids || []).map(id => { const p = propertiesData.find(x => Number(x.property_id) === Number(id)); return p ? p.property_name : null; }).filter(Boolean);
    return names.length ? names.map(n => chip(n, 'bg-blue-900/30 text-blue-300 border-blue-500/30')).join(' ') : chip('No project', 'bg-rose-900/30 text-rose-300 border-rose-500/30');
}
async function loadStaff() {
    if (!canTeam()) return;
    const r = await api('/api/users'); if (!r.ok) return;
    usersData = r.data;
    const actions = s => `<td class="p-3 whitespace-nowrap"><button onclick="openUserModal(${Number(s.user_id)})" class="w-7 h-7 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40"><i class="fa-solid fa-pen text-[10px]"></i></button>
            ${String(s.user_id) !== String(currentUserInfo().user_id) ? ` <button onclick="deleteUser(${Number(s.user_id)})" class="w-7 h-7 rounded-lg bg-red-600/20 text-red-300 border border-red-500/40"><i class="fa-solid fa-trash-can text-[10px]"></i></button>` : ''}</td>`;
    const sb = document.getElementById('table-staff-body');
    if (sb) sb.innerHTML = usersData.length === 0 ? '<tr><td colspan="5" class="p-4 text-center text-gray-500">No users.</td></tr>' : usersData.map(s => `
        <tr class="hover:bg-[#14223d]/50"><td class="p-3 font-bold text-white">${esc(s.full_name)}${s.department_name ? `<div class="text-[10px] font-normal text-gray-500">${esc(s.department_name)}</div>` : ''}</td>
            <td class="p-3 text-gray-400">${esc(s.email)}<div class="text-[10px]">${esc(s.phone_number || '')}</div></td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-300 border border-blue-500/30">${esc(ROLE_LABEL[s.role] || s.role)}</span></td>
            <td class="p-3 ${s.is_active ? 'text-emerald-400' : 'text-rose-400'}">${s.is_active ? 'Active' : 'Switched off'}</td>
            ${actions(s)}</tr>`).join('');
    const sp = document.getElementById('st-people');
    if (sp) sp.innerHTML = usersData.length === 0 ? '<tr><td colspan="5" class="p-4 text-center text-gray-500">No people yet.</td></tr>' : usersData.map(s => `
        <tr class="hover:bg-[#14223d]/50"><td class="p-3 font-bold text-white">${esc(s.full_name)}<div class="text-[10px] font-normal text-gray-500">${esc(s.job_title || s.email)}</div></td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-300 border border-blue-500/30">${esc(ROLE_LABEL[s.role] || s.role)}</span>${s.can_add_staff ? ' ' + chip('Can add people', 'bg-amber-900/30 text-amber-300 border-amber-500/30') : ''}${s.is_active ? '' : ' ' + chip('Switched off', 'bg-rose-900/30 text-rose-300 border-rose-500/30')}</td>
            <td class="p-3 text-gray-300">${esc(s.department_name || '-')}</td>
            <td class="p-3"><div class="flex flex-wrap gap-1">${accessCell(s)}</div></td>
            ${actions(s)}</tr>`).join('');
}
async function openUserModal(id, presetDept, presetProject) {
    const u = id ? usersData.find(x => Number(x.user_id) === Number(id)) : null;
    document.getElementById('us-id').value = u ? u.user_id : ''; document.getElementById('us-title').innerText = u ? 'Edit User' : 'Add User';
    document.getElementById('us-name').value = u ? u.full_name : ''; document.getElementById('us-email').value = u ? u.email : ''; document.getElementById('us-email').disabled = !!u;
    document.getElementById('us-phone').value = u ? (u.phone_number || '') : ''; document.getElementById('us-pass').value = '';
    document.getElementById('us-pw-label').innerText = u ? 'New password (leave empty to keep)' : 'Password * (min 8)';
    document.getElementById('us-pass').required = !u;
    { const r2 = document.getElementById('us-2fa-row'); if (r2) r2.classList.toggle('hidden', !(u && isAdminRole())); }
    // only the administrator can make another administrator
    const adminOpt = document.querySelector('#us-role option[value="COMPANY_ADMIN"]'); if (adminOpt) adminOpt.hidden = adminOpt.disabled = !isAdminRole();
    document.getElementById('us-role').value = u ? u.role : 'PROPERTY_MANAGER'; document.getElementById('us-edit').checked = u ? !!u.can_edit_tenants : false;
    document.getElementById('us-active').checked = u ? !!u.is_active : true; document.getElementById('us-active-wrap').classList.toggle('hidden', !u);
    document.getElementById('us-active-wrap').style.display = u ? 'flex' : 'none';
    await prepareUserOrg(u, presetDept, presetProject);
    openModal('modal-user');
}
async function saveUser(e) {
    e.preventDefault();
    const id = document.getElementById('us-id').value;
    const body = { full_name: document.getElementById('us-name').value, email: document.getElementById('us-email').value, phone_number: document.getElementById('us-phone').value,
        role: document.getElementById('us-role').value, can_edit_tenants: document.getElementById('us-edit').checked, is_active: document.getElementById('us-active').checked };
    const pw = document.getElementById('us-pass').value; if (pw) body.password = pw;
    if (body.role === 'COMPANY_ADMIN') { /* the administrator sees everything */ } else { const err = await readUserOrg(body); if (err) return alert(err); }
    const r = await api(id ? `/api/users/${id}` : '/api/users', id ? 'PUT' : 'POST', body);
    if (r.ok) { closeModal('modal-user'); loadStaff(); if (currentPage === 'structure') loadStructure(); } else alert(r.data.error || 'Failed');
}
async function deleteUser(id) {
    const u = usersData.find(x => Number(x.user_id) === Number(id));
    if (!confirm(`Remove ${u ? u.full_name : 'this user'}? They will not be able to sign in.`)) return;
    const r = await api(`/api/users/${id}`, 'DELETE');
    if (r.ok) { loadStaff(); if (currentPage === 'structure') loadStructure(); } else alert(r.data.error || 'Failed');
}

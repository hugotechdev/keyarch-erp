// ============================================================
// PLATFORM ADMIN (Super Admin)
// ============================================================
let platformCompanies = [];
let platformFilter = 'all';
let platformSearch = '';
let platformReceived = 0;

function pfStatus(c) {
    if (c.access_status === 'PENDING') return 'pending';
    if (c.access_status === 'SUSPENDED' || c.is_active === false) return 'suspended';
    if (c.expired) return 'expired';
    if (c.billing_type === 'SUBSCRIPTION' && c.days_left !== null && Number(c.days_left) <= 7) return 'expiring';
    return 'active';
}
function waLink(phone) {
    let d = String(phone || '').replace(/[^\d]/g, '');
    if (d.startsWith('0')) d = '255' + d.slice(1);
    return d ? `https://wa.me/${d}` : '';
}

async function sendTestEmail() {
    const r = await api('/api/platform/test-email', 'POST', {});
    alert((r.data && (r.data.message || r.data.error)) || 'Done.');
}
async function loadOwnerAccount() {
    const r = await api('/api/platform/account');
    if (!r.ok) return;
    document.getElementById('own-name').value = r.data.full_name || '';
    document.getElementById('own-email').value = r.data.email || '';
}
async function saveOwnerAccount() {
    const cur = document.getElementById('own-cur').value;
    if (!cur) return alert('Enter your current password to save.');
    const r = await api('/api/platform/account', 'PUT', {
        full_name: document.getElementById('own-name').value, email: document.getElementById('own-email').value,
        new_password: document.getElementById('own-new').value || undefined, current_password: cur });
    if (!r.ok) return alert((r.data && r.data.error) || 'Could not save.');
    document.getElementById('own-cur').value = ''; document.getElementById('own-new').value = '';
    try { const u = JSON.parse(localStorage.getItem('keyarch_user') || '{}'); u.email = r.data.email; u.full_name = r.data.full_name; localStorage.setItem('keyarch_user', JSON.stringify(u)); } catch (e) { }
    alert('Saved.');
}
async function loadPlatform() {
    loadOwnerAccount();
    const r = await api('/api/platform/companies');
    if (!r.ok) return;
    platformCompanies = r.data.companies || [];
    platformReceived = r.data.received_this_month || 0;
    renderPlatform();
}

function setPlatformFilter(f) { platformFilter = f; renderPlatform(); }

function renderPlatform() {
    const list = platformCompanies;
    const st = list.map(pfStatus);
    setText('pf-kpi-total', list.length);
    setText('pf-kpi-active', st.filter(s => s === 'active' || s === 'expiring').length);
    setText('pf-kpi-pending', st.filter(s => s === 'pending').length);
    setText('pf-kpi-expiring', st.filter(s => s === 'expiring').length);
    setText('pf-kpi-blocked', st.filter(s => s === 'expired' || s === 'suspended').length);
    setText('pf-kpi-received', money(platformReceived));

    document.querySelectorAll('.pf-chip').forEach(chip => {
        const on = chip.dataset.pf === platformFilter;
        chip.classList.toggle('bg-blue-600', on); chip.classList.toggle('text-white', on);
        chip.classList.toggle('border-blue-500', on); chip.classList.toggle('text-gray-400', !on);
    });

    const rows = list.filter(c => {
        const s = pfStatus(c);
        const pass = platformFilter === 'all' ? true
            : platformFilter === 'active' ? (s === 'active' || s === 'expiring')
            : platformFilter === 'blocked' ? (s === 'expired' || s === 'suspended')
            : s === platformFilter;
        if (!pass) return false;
        if (!platformSearch) return true;
        return [c.company_name, c.owner_name, c.owner_email, c.owner_phone].some(v => String(v || '').toLowerCase().includes(platformSearch));
    });

    const badges = {
        pending: '<span class="px-2 py-0.5 rounded text-[10px] bg-amber-900/40 text-amber-300 border border-amber-500/30">Waiting Payment</span>',
        active: '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-900/40 text-emerald-300 border border-emerald-500/30">Active</span>',
        expiring: '<span class="px-2 py-0.5 rounded text-[10px] bg-orange-900/40 text-orange-300 border border-orange-500/30">Ending Soon</span>',
        expired: '<span class="px-2 py-0.5 rounded text-[10px] bg-red-900/40 text-red-300 border border-red-500/30">Subscription Ended</span>',
        suspended: '<span class="px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-300 border border-gray-600/40">Suspended</span>'
    };

    document.getElementById('pf-body').innerHTML = rows.length === 0
        ? '<tr><td colspan="6" class="p-4 text-center text-gray-500">No companies in this view.</td></tr>'
        : rows.map(c => {
            const s = pfStatus(c);
            const wa = waLink(c.owner_phone);
            const billing = c.billing_type === 'SUBSCRIPTION'
                ? `Subscription<div class="text-[10px] ${s === 'expired' ? 'text-red-400' : 'text-gray-500'}">until ${esc(c.paid_until || '-')}${c.days_left !== null && s !== 'expired' ? ' (' + c.days_left + 'd)' : ''}</div>`
                : (c.billing_type === 'ONE_TIME' ? 'One-time<div class="text-[10px] text-gray-500">permanent</div>' : '<span class="text-gray-500">Not paid yet</span>');
            return `
            <tr class="hover:bg-[#14223d]/50">
                <td class="p-3"><div class="font-bold text-white">${esc(c.company_name)}</div>
                    <div class="text-[10px] text-gray-400">${esc(c.owner_name || '-')} · ${esc(c.owner_phone || '')}</div>
                    <div class="text-[10px] text-gray-500">${esc(c.owner_email || '')}</div></td>
                <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] ${c.plan === 'PRO' ? 'bg-indigo-900/50 text-indigo-300 border border-indigo-500/40' : 'bg-[#14223d] text-gray-300 border border-[#233863]'}">${c.plan === 'PRO' ? 'PRO' : 'STANDARD'}</span></td>
                <td class="p-3">${billing}</td>
                <td class="p-3 text-[11px]">${c.properties} properties · ${c.units} units<div class="text-gray-500">${c.tenants} tenants · ${c.staff} staff</div></td>
                <td class="p-3">${badges[s]}</td>
                <td class="p-3 whitespace-nowrap space-x-1">
                    <button onclick="openPlatformCompany(${Number(c.company_id)})" class="px-2.5 py-1 bg-blue-600/30 text-blue-300 border border-blue-500/50 rounded font-bold hover:bg-blue-600 hover:text-white transition">Manage</button>
                    <button onclick="openPlatformPayment(${Number(c.company_id)})" class="px-2.5 py-1 bg-emerald-600/30 text-emerald-300 border border-emerald-500/50 rounded font-bold hover:bg-emerald-600 hover:text-white transition">Payment</button>
                    ${wa ? `<a href="${wa}" target="_blank" rel="noopener" class="inline-block px-2 py-1 bg-[#14223d] text-emerald-300 border border-[#233863] rounded hover:bg-emerald-700 hover:text-white transition"><i class="fa-brands fa-whatsapp"></i></a>` : ''}
                </td>
            </tr>`;
        }).join('');
}

async function openPlatformCompany(id) {
    const c = platformCompanies.find(x => String(x.company_id) === String(id));
    if (!c) return;
    document.getElementById('pc-id').value = c.company_id;
    setText('pc-title', c.company_name);
    setText('pc-owner', `${c.owner_name || '-'} · ${c.owner_phone || ''} · ${c.owner_email || ''}`);
    document.getElementById('pc-status').value = c.access_status || 'ACTIVE';
    document.getElementById('pc-plan').value = c.plan || 'STANDARD';
    document.getElementById('pc-billing').value = c.billing_type || '';
    document.getElementById('pc-until').value = c.paid_until || '';
    document.getElementById('pc-notes').value = c.notes || '';

    const f = c.features || {};
    ['luku', 'tickets', 'reports_advanced', 'backup_full'].forEach(k => {
        document.getElementById('pc-f-' + k).value = typeof f[k] === 'boolean' ? (f[k] ? 'on' : 'off') : '';
    });
    ['max_properties', 'max_staff'].forEach(k => {
        document.getElementById('pc-l-' + k).value = typeof f[k] === 'number' ? f[k] : '';
    });

    document.getElementById('pc-payments').innerHTML = '<div class="p-3 text-center text-gray-500">Loading...</div>';
    openModal('modal-platform-company');

    const r = await api(`/api/platform/companies/${encodeURIComponent(id)}/payments`);
    const labels = { SUBSCRIPTION: 'Subscription', ONE_TIME: 'One-time', MAINTENANCE: 'Maintenance', FEATURE: 'New feature' };
    document.getElementById('pc-payments').innerHTML = !r.ok || r.data.length === 0
        ? '<div class="p-3 text-center text-gray-500">No payments recorded yet.</div>'
        : r.data.map(p => `
            <div class="flex justify-between gap-2 p-2.5 rounded-lg bg-[#14223d]">
                <span class="text-gray-300">${fmtDate(p.paid_at)} · ${labels[p.payment_type] || esc(p.payment_type)}${p.months ? ' (' + p.months + ' mo)' : ''}
                    <span class="text-gray-500">· ${esc(p.method || '')} ${esc(p.reference || '')}</span></span>
                <span class="font-bold text-emerald-400 whitespace-nowrap">${money(p.amount)}</span>
            </div>`).join('');
}

async function savePlatformCompany() {
    const id = document.getElementById('pc-id').value;
    const features = {};
    ['luku', 'tickets', 'reports_advanced', 'backup_full'].forEach(k => {
        const v = document.getElementById('pc-f-' + k).value;
        if (v === 'on') features[k] = true;
        if (v === 'off') features[k] = false;
    });
    ['max_properties', 'max_staff'].forEach(k => {
        const v = document.getElementById('pc-l-' + k).value;
        if (v !== '') features[k] = parseInt(v);
    });
    const r = await api(`/api/platform/companies/${encodeURIComponent(id)}`, 'PUT', {
        access_status: document.getElementById('pc-status').value,
        plan: document.getElementById('pc-plan').value,
        billing_type: document.getElementById('pc-billing').value,
        paid_until: document.getElementById('pc-until').value,
        notes: document.getElementById('pc-notes').value,
        features
    });
    if (r.ok) { closeModal('modal-platform-company'); loadPlatform(); alert('Company updated.'); }
    else alert('Failed: ' + (r.data.error || 'Server error'));
}

function onPlatformPaymentType() {
    const t = document.getElementById('pp-type').value;
    document.getElementById('pp-months-wrap').style.display = t === 'SUBSCRIPTION' ? 'block' : 'none';
    if (t === 'ONE_TIME') document.getElementById('pp-plan').value = 'PRO';
}

function openPlatformPayment(id) {
    const c = platformCompanies.find(x => String(x.company_id) === String(id));
    if (!c) return;
    document.getElementById('pp-company-id').value = c.company_id;
    setText('pp-company', `${c.company_name} · ${c.owner_name || ''}`);
    document.getElementById('pp-type').value = c.access_status === 'PENDING' ? 'SUBSCRIPTION' : 'SUBSCRIPTION';
    document.getElementById('pp-plan').value = '';
    document.getElementById('pp-months').value = 1;
    document.getElementById('pp-amount').value = '';
    document.getElementById('pp-ref').value = '';
    document.getElementById('pp-notes').value = '';
    onPlatformPaymentType();
    closeModal('modal-platform-company');
    openModal('modal-platform-payment');
}

async function submitPlatformPayment(e) {
    e.preventDefault();
    const id = document.getElementById('pp-company-id').value;
    const amount = parseMoney(document.getElementById('pp-amount').value);
    if (!(amount > 0)) return alert('Please enter the amount received.');
    const r = await api(`/api/platform/companies/${encodeURIComponent(id)}/payments`, 'POST', {
        payment_type: document.getElementById('pp-type').value,
        plan: document.getElementById('pp-plan').value || undefined,
        months: parseInt(document.getElementById('pp-months').value) || 1,
        amount,
        method: document.getElementById('pp-method').value,
        reference: document.getElementById('pp-ref').value,
        notes: document.getElementById('pp-notes').value
    });
    if (r.ok) {
        closeModal('modal-platform-payment');
        loadPlatform();
        alert(r.data.paid_until ? `Payment saved. Access is active until ${r.data.paid_until}.` : 'Payment saved. Access is active.');
    } else alert('Failed: ' + (r.data.error || 'Server error'));
}

async function resetOwnerPassword() {
    const id = document.getElementById('pc-id').value;
    const pw = prompt('Type a new password for the owner of this company (at least 8 characters):');
    if (!pw) return;
    const r = await api(`/api/platform/companies/${encodeURIComponent(id)}/reset-password`, 'POST', { password: pw });
    alert(r.ok ? r.data.message : 'Failed: ' + (r.data.error || 'Server error'));
}

// ============================================================
// v6 LAYER: helpers, roles, properties, invoices, receipts
// ============================================================
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 05 Nov 2026  (works with 2026-11-05 and with full timestamps)
function fmtDate(d, empty) {
    if (!d) return empty === undefined ? '-' : empty;
    const s = String(d);
    let y, m, day;
    const mt = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (mt && s.length <= 10) { y = +mt[1]; m = +mt[2] - 1; day = +mt[3]; }
    else { const dt = new Date(s); if (isNaN(dt)) return s; y = dt.getFullYear(); m = dt.getMonth(); day = dt.getDate(); }
    return `${String(day).padStart(2, '0')} ${MON[m]} ${y}`;
}
function todayISO() { return toDateInput(new Date()); }
function monthStartISO(d) { d = d || new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }
function fmtN(n) { return (Number(n) || 0).toLocaleString('en-US'); }

// ---- roles ----
function role() { return currentUserInfo().role; }
function isAdminRole() { return ['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(role()); }
function canManage() { return ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'].includes(role()); }
function canMoney() { return ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'].includes(role()); }
function isTech() { return role() === 'MAINTENANCE_MANAGER'; }
// Pro: which projects this person may see (null = all) and whether he may add people
function myAccess() { return currentUserInfo().access || { scoped: false, project_ids: null, can_add_staff: false }; }
function isScoped() { return !!myAccess().scoped; }
function canTeam() { return isAdminRole() || !!myAccess().can_add_staff; }
// what each job title sees in the menu (the server checks the same rules again)
const NAV_ACCESS = {
    SUPER_ADMIN: [],
    COMPANY_ADMIN: ['dashboard', 'properties', 'tenants', 'invoices', 'luku', 'maintenance', 'expenses', 'finance', 'reports', 'requests'],
    PROPERTY_MANAGER: ['dashboard', 'properties', 'tenants', 'invoices', 'luku', 'maintenance', 'expenses', 'finance', 'reports', 'requests'],
    ACCOUNTANT: ['dashboard', 'tenants', 'invoices', 'luku', 'expenses', 'finance', 'reports', 'requests'],
    MAINTENANCE_MANAGER: ['maintenance'],
    VIEWER: ['dashboard', 'properties', 'tenants', 'invoices', 'reports']
};
function canSeePage(pg) { if (pg === 'platform') return role() === 'SUPER_ADMIN'; if (pg === 'structure') return role() !== 'SUPER_ADMIN' && canTeam() && hasFeature('structure'); if (pg === 'svcowners') return role() !== 'SUPER_ADMIN' && ['COMPANY_ADMIN','PROPERTY_MANAGER','ACCOUNTANT','VIEWER'].includes(role()) && !isScoped(); if (isScoped() && (pg === 'finance' || pg === 'luku')) return false; if (pg === 'settings' || pg === 'upgrade') return true; return (NAV_ACCESS[role()] || []).includes(pg); }
function applyRoleUI() {
    const show = (sel, ok) => document.querySelectorAll(sel).forEach(el => el.style.display = ok ? '' : 'none');
    show('.can-manage', canManage()); show('.can-money', canMoney()); show('.can-fin', canFin()); show('.can-admin', isAdminRole());
    show('.can-tickets', canManage() || isTech());
    const allowed = NAV_ACCESS[role()] || NAV_ACCESS.VIEWER;
    document.querySelectorAll('.nav-item[data-page]').forEach(b => {
        const pg = b.getAttribute('data-page');
        if (pg === 'platform' || pg === 'settings') return;
        b.style.display = (pg === 'structure' || pg === 'svcowners' ? canSeePage(pg) : (allowed.includes(pg) && canSeePage(pg))) ? '' : 'none';
    });
    show('.st-newproj', canManage() && (!isScoped() || !!myAccess().can_add_staff));
    const tech = isTech();
    const nm = document.getElementById('menu-new'); if (nm && nm.parentElement) nm.parentElement.style.display = (tech || role() === 'SUPER_ADMIN' || role() === 'VIEWER') ? 'none' : '';
    const us = document.getElementById('set-users-card'); if (us) us.style.display = isAdminRole() ? '' : 'none';
    const pr = document.getElementById('set-profile-card'); if (pr) pr.style.display = role() === 'VIEWER' || isTech() ? 'none' : '';
    const gs = document.getElementById('global-search'); if (gs && tech) gs.parentElement.style.display = 'none';
}

// ---- downloads & printing ----
async function downloadFile(url, filename) {
    try {
        const token = localStorage.getItem('keyarch_token');
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) { let d = {}; try { d = await res.json(); } catch (e) { } return alert(d.error || 'Download failed.'); }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    } catch (e) { alert('Download failed: ' + e.message); }
}
function printArea(id) {
    const el = document.getElementById(id); if (!el) return;
    el.classList.add('print-target'); document.body.classList.add('print-one');
    window.onafterprint = () => { el.classList.remove('print-target'); document.body.classList.remove('print-one'); };
    window.print();
}

// ---- phone / WhatsApp ----
function phoneDigits(p) {
    let d = String(p || '').replace(/[^\d]/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('0')) d = '255' + d.slice(1);
    else if (d.length === 9) d = '255' + d;
    return d;
}
function waUrl(phone, text) { const d = phoneDigits(phone); return d ? `https://wa.me/${d}${text ? '?text=' + encodeURIComponent(text) : ''}` : ''; }
function contactBtns(phone, text, small) {
    if (!phone) return '';
    const sz = small ? 'w-7 h-7 text-xs' : 'px-3 py-2 text-xs font-bold';
    return `<a href="tel:+${phoneDigits(phone)}" title="Call" class="inline-flex items-center justify-center gap-1 ${sz} rounded-lg bg-sky-600/30 text-sky-300 border border-sky-500/40 hover:bg-sky-600 hover:text-white"><i class="fa-solid fa-phone"></i>${small ? '' : ' Call'}</a>` +
        ` <a href="${waUrl(phone, text)}" target="_blank" rel="noopener" title="WhatsApp" class="inline-flex items-center justify-center gap-1 ${sz} rounded-lg bg-green-600/30 text-green-300 border border-green-500/40 hover:bg-green-600 hover:text-white"><i class="fa-brands fa-whatsapp"></i>${small ? '' : ' WhatsApp'}</a>`;
}
function remindText(name, owed, company) {
    return `Habari ${name}, huu ni ukumbusho kutoka ${company || 'ofisi yetu'}. Una deni la ${money(owed)}. Tafadhali lipa mapema. Asante.`;
}
function companyName() { return (currentUserInfo().company && currentUserInfo().company.company_name) || currentUserInfo().company_name || ''; }

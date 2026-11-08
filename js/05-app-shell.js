function switchAuthTab(type) {
    const loginForm = document.getElementById('form-login');
    const regForm = document.getElementById('form-portal-register');
    const tabLogin = document.getElementById('tab-auth-login');
    const tabReg = document.getElementById('tab-auth-register');

    if (type === 'login') {
        loginForm.classList.remove('hidden');
        regForm.classList.add('hidden');
        tabLogin.classList.add('bg-blue-600', 'text-white');
        tabLogin.classList.remove('text-gray-400');
        tabReg.classList.remove('bg-blue-600', 'text-white');
        tabReg.classList.add('text-gray-400');
    } else {
        loginForm.classList.add('hidden');
        regForm.classList.remove('hidden');
        tabReg.classList.add('bg-blue-600', 'text-white');
        tabReg.classList.remove('text-gray-400');
        tabLogin.classList.remove('bg-blue-600', 'text-white');
        tabLogin.classList.add('text-gray-400');
    }
}

async function sendPost(url, bodyData, modalId, formId) {
    const token = localStorage.getItem('keyarch_token');
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(bodyData)
    });
    if (res.ok) {
        if (formId) document.getElementById(formId).reset();
        closeModal(modalId);
        loadAllData();
        alert('Action completed successfully.');
    } else {
        const data = await res.json();
        alert('Failed: ' + (data.error || 'Server error'));
    }
}

function togglePw(id, btn) {
    const el = document.getElementById(id); const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    btn.innerHTML = `<i class="fa-solid ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
}
function copyLukuToken() {
    navigator.clipboard.writeText(document.getElementById('res-token').innerText);
    alert('Token copied!');
}

async function loadTablesData() {
    const r = await api('/api/tenants');
    if (r.ok) { currentTenantsList = r.data; renderTenantOverview(); applyTenantFilters(); }
}

// ============================================================
// APP SHELL: sidebar, header menus, pages
// ============================================================
let currentInvoices = [];
let overviewData = null;
const PAGE_TITLES = {
    dashboard: 'Dashboard', properties: 'Properties & Units', tenants: 'Tenants & Leases',
    invoices: 'Invoices & Payments', luku: 'Luku', maintenance: 'Maintenance',
    expenses: 'Expenses', structure: 'Structure', svcowners: 'Owners & Service Charge', finance: 'Finance', reports: 'Reports', settings: 'Settings', platform: 'Platform Admin', upgrade: 'Upgrade', requests: 'Edit Requests'
};

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('-translate-x-full');
    document.getElementById('sidebar-backdrop').classList.toggle('hidden');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.add('-translate-x-full');
    document.getElementById('sidebar-backdrop').classList.add('hidden');
}

function closeMenus() {
    ['menu-new', 'menu-bell', 'menu-user'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
}
function toggleMenu(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const wasHidden = el.classList.contains('hidden');
    closeMenus();
    if (wasHidden) el.classList.remove('hidden');
}
document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-menu]')) closeMenus();
});

let currentPage = 'dashboard';
function onPageShown(page) {
    currentPage = page;
    if (page === 'luku') loadLuku(); else if (page === 'maintenance') loadTickets(); else if (page === 'expenses') loadExpenses();
    else if (page === 'structure') loadStructure(); else if (page === 'svcowners') loadSvcOwners(); else if (page === 'requests') loadRequests(); else if (page === 'finance') initFinance();
    else if (page === 'reports') initReports(); else if (page === 'invoices') { setInvTab(invTab); } else if (page === 'settings') { loadProfile(); loadStaff(); }
}
function showPage(page) {
    if (!canSeePage(page)) page = role() === 'SUPER_ADMIN' ? 'platform' : (isTech() ? 'maintenance' : 'dashboard');
    const gate = FEATURE_PAGES[page];
    if (gate && !hasFeature(gate)) { showUpgrade(page); return; }
    document.querySelectorAll('.app-page').forEach(el => el.classList.add('hidden'));
    document.getElementById('page-' + page)?.classList.remove('hidden');

    document.querySelectorAll('.nav-item').forEach(btn => {
        const active = btn.dataset.page === page;
        btn.classList.toggle('bg-blue-600/20', active);
        btn.classList.toggle('text-blue-300', active);
        btn.classList.toggle('text-gray-400', !active);
    });

    document.getElementById('page-title').innerText = PAGE_TITLES[page] || page;
    closeMenus();
    if (window.innerWidth < 1024) closeSidebar();
    window.scrollTo(0, 0);
    if (page !== 'upgrade' && page !== 'platform') onPageShown(page);
}

function globalSearch(value) {
    showPage('tenants');
    const box = document.getElementById('tenant-search');
    if (box) box.value = value;
    tenantFilter = 'all';
    syncFilterChips();
    filterTenants(value);
}

function showAppView() {
    document.getElementById('view-login').style.display = 'none';
    document.getElementById('view-admin-login').style.display = 'none';
    document.getElementById('view-app').style.display = 'block';

    const user = JSON.parse(localStorage.getItem('keyarch_user') || '{}');
    const company = user.company_name || 'Hugo Tech';
    const monthYear = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    document.getElementById('user-role-badge').innerText = user.role || 'COMPANY_ADMIN';
    document.getElementById('user-company-display').innerText = company;
    document.getElementById('user-name-display').innerText = user.full_name || 'User';
    document.getElementById('user-avatar').innerText = (user.full_name || 'U').trim().charAt(0).toUpperCase();
    document.getElementById('sidebar-company').innerText = company;
    document.getElementById('page-subtitle').innerText = `${company} · ${monthYear}`;
    document.getElementById('set-company').innerText = company;
    document.getElementById('set-name').innerText = user.full_name || '-';
    document.getElementById('set-email').innerText = `${user.email || '-'} · ${(ROLE_LABEL && ROLE_LABEL[user.role]) || user.role || ''}`;

    applyRoleUI();
    if (user.role === 'SUPER_ADMIN') { showPage('platform'); loadPlatform(); }
    else if (user.role === 'MAINTENANCE_MANAGER') showPage('maintenance');
    else showPage('dashboard');
    applyFeatureUI();
    loadMe();
    loadAllData();
}

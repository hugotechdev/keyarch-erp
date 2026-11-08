// ============================================================
// ACCESS CONTROL, PLANS (Standard / Pro) AND PLATFORM ADMIN
// ============================================================
const FEATURE_PAGES = { luku: 'luku', maintenance: 'tickets', structure: 'org', svcowners: 'org' };
const FEATURE_LABELS = { luku: 'Luku', tickets: 'Maintenance tickets', reports_advanced: 'Advanced reports', backup_full: 'Full backup' };

function isSuperAdmin() { return currentUserInfo().role === 'SUPER_ADMIN'; }
function hasFeature(key) {
    if (isSuperAdmin()) return true;
    const c = currentUserInfo().company;
    return !!(c && c.features && c.features[key]);
}
function requireFeature(key) {
    if (hasFeature(key)) return true;
    showUpgrade(key === 'luku' ? 'luku' : 'maintenance');
    return false;
}
function showUpgrade(page) {
    const label = page === 'luku' ? 'Luku' : (page === 'svcowners' ? 'Owners and service charge' : page === 'structure' ? 'Departments and project access' : 'Maintenance Tickets');
    setText('up-title', label + ' is a Pro feature');
    setText('up-text', `Your current plan does not include ${label}. Contact HUGO TECH to upgrade to Pro and get full access.`);
    showPage('upgrade');
}

async function api(url, method, body) {
    const token = localStorage.getItem('keyarch_token');
    const res = await fetch(url, {
        method: method || 'GET',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    return { ok: res.ok, status: res.status, data };
}

// Lock screen when the company is unpaid / suspended / expired
const LOCK_CODES = ['ACCOUNT_PENDING', 'ACCOUNT_SUSPENDED', 'SUBSCRIPTION_EXPIRED'];
let sessionAlertShown = false;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
    const res = await nativeFetch(url, opts);
    if ((res.status === 401 || res.status === 403) && !/\/api\/auth\/(login|admin-login|forgot-password|reset-password|register-company)/.test(String(url))) {
        try {
            const data = await res.clone().json();
            if (LOCK_CODES.includes(data.code)) showLockedScreen(data.error);
            else if (res.status === 401 || /session expired|invalid token/i.test(data.error || '')) sessionExpired();
        } catch (e) { /* not json */ }
    }
    return res;
};

function showLockedScreen(message) {
    localStorage.removeItem('keyarch_token');
    localStorage.removeItem('keyarch_user');
    document.getElementById('view-login').style.display = 'none';
    document.getElementById('view-app').style.display = 'none';
    document.getElementById('view-locked').style.display = 'flex';
    setText('locked-message', message || 'Your account is not active.');
}
function sessionExpired() {
    if (sessionAlertShown) return;
    sessionAlertShown = true;
    localStorage.removeItem('keyarch_token');
    localStorage.removeItem('keyarch_user');
    alert('Your session has ended. Please sign in again.');
    window.location.reload();
}

// refresh plan + features from the server, then update the screen
async function loadMe() {
    const r = await api('/api/me');
    if (!r.ok || !r.data.company) return;
    const user = currentUserInfo();
    user.company = r.data.company;
    user.access = r.data.access || { scoped: false, project_ids: null, can_add_staff: false, department_id: null };
    localStorage.setItem('keyarch_user', JSON.stringify(user));
    applyFeatureUI(); applyRoleUI();
}

function applyFeatureUI() {
    const user = currentUserInfo();
    const c = user.company || {};
    const superAdmin = user.role === 'SUPER_ADMIN';
    const planLabel = c.plan === 'PRO' ? 'Pro' : 'Standard';
    const monthYear = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    document.getElementById('nav-platform').classList.toggle('hidden', !superAdmin);
    document.getElementById('nav-pro-luku').classList.toggle('hidden', hasFeature('luku'));
    document.getElementById('nav-pro-maintenance').classList.toggle('hidden', hasFeature('tickets'));
    document.getElementById('nav-pro-structure').classList.toggle('hidden', hasFeature('org'));
    document.getElementById('nav-pro-svcowners').classList.toggle('hidden', hasFeature('org'));
    applyOrgOnly();
    setText('page-subtitle', `${c.company_name || user.company_name || ''} · ${superAdmin ? 'Platform Owner' : planLabel + ' Plan'} · ${monthYear}`);
    setText('user-plan-badge', superAdmin ? 'PLATFORM OWNER' : planLabel.toUpperCase() + ' PLAN');

    // settings: plan card
    setText('set-plan', superAdmin ? 'Platform Owner' : planLabel);
    setText('set-billing', c.billing_type === 'SUBSCRIPTION' ? 'Subscription (monthly)' : (c.billing_type === 'ONE_TIME' ? 'One-time (permanent)' : '-'));
    setText('set-until', c.billing_type === 'SUBSCRIPTION' && c.paid_until ? c.paid_until : (c.billing_type === 'ONE_TIME' ? 'Permanent' : '-'));
    const feats = c.features || {};
    document.getElementById('set-features').innerHTML = Object.keys(FEATURE_LABELS).map(k => {
        const on = superAdmin || !!feats[k];
        return `<span class="px-2.5 py-1 rounded-full border ${on ? 'bg-emerald-900/30 text-emerald-300 border-emerald-500/30' : 'bg-[#14223d] text-gray-500 border-[#233863]'}"><i class="fa-solid ${on ? 'fa-check' : 'fa-lock'} mr-1"></i>${FEATURE_LABELS[k]}</span>`;
    }).join('') + (feats.max_properties ? `<span class="px-2.5 py-1 rounded-full border bg-[#14223d] text-gray-300 border-[#233863]">Up to ${feats.max_properties} properties</span>` : '')
                + (feats.max_staff ? `<span class="px-2.5 py-1 rounded-full border bg-[#14223d] text-gray-300 border-[#233863]">Up to ${feats.max_staff} staff</span>` : '');

    // warning when a subscription is about to end
    const banner = document.getElementById('sub-banner');
    if (!superAdmin && c.billing_type === 'SUBSCRIPTION' && c.days_left !== null && c.days_left <= 7) {
        banner.classList.remove('hidden');
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-2"></i>Your subscription ${c.days_left < 0 ? 'has ended' : (c.days_left === 0 ? 'ends today' : 'ends in ' + c.days_left + ' day(s)')} (${esc(c.paid_until)}). Contact HUGO TECH on WhatsApp <a class="underline font-bold" href="https://wa.me/255785799530" target="_blank" rel="noopener">+255 785 799 530</a> to renew.`;
    } else banner.classList.add('hidden');
}

// ============================================================
// VERSIONS + DATABASE SETUP CHECK
// ============================================================
const PAGE_VERSION = 'v10.0 - 2026-11-08 - split into section files (js and server folders)';

async function checkVersions() {
    let serverVersion = 'unknown (old server.js?)';
    try {
        const res = await nativeFetch('/api/version');
        if (res.ok) serverVersion = (await res.json()).server_version;
    } catch (e) { /* offline */ }
    const same = serverVersion === PAGE_VERSION;
    const text = `Page: ${PAGE_VERSION} | Server: ${serverVersion}`;
    setText('set-version', text);
    const el = document.getElementById('pf-version');
    if (el) {
        el.innerHTML = same
            ? `<span class="text-emerald-400">Both files are the same version.</span> ${esc(PAGE_VERSION)}`
            : `<span class="text-amber-300 font-bold">The two files are different versions. Upload BOTH index.html and server.js to GitHub.</span><br>Page: ${esc(PAGE_VERSION)}<br>Server: ${esc(serverVersion)}`;
    }
}
document.addEventListener('DOMContentLoaded', checkVersions);

async function runDatabaseSetup() {
    const box = document.getElementById('pf-setup-result');
    box.className = 'text-xs rounded-xl p-3 bg-[#14223d] text-gray-300';
    box.innerText = 'Running database setup...';
    const r = await api('/api/platform/setup-database', 'POST');
    if (!r.ok) {
        box.className = 'text-xs rounded-xl p-3 bg-red-900/30 border border-red-500/40 text-red-200';
        box.innerText = 'Could not run the setup: ' + (r.data.error || 'This server does not have the setup check. Upload the new server.js.');
        return;
    }
    const failed = r.data.failed || [];
    if (failed.length === 0) {
        box.className = 'text-xs rounded-xl p-3 bg-emerald-900/30 border border-emerald-500/40 text-emerald-200';
        box.innerText = `All ${r.data.total} database steps are OK. Sign out and sign in again, then refresh the page.`;
        loadPlatform();
    } else {
        box.className = 'text-xs rounded-xl p-3 bg-red-900/30 border border-red-500/40 text-red-200 space-y-1';
        box.innerHTML = `<div class="font-bold">${failed.length} step(s) failed out of ${r.data.total}. Copy this and send it to your developer / Claude:</div>` +
            failed.map(f => `<div class="font-mono break-words">• ${esc(f.step)} → ${esc(f.error)}</div>`).join('');
    }
}

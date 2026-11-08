let selectedPropertyType = 'Apartment';
let groupCounter = 0;
let currentTenantsList = [];

// SAFE TEXT: stops names like <script> from running inside the page
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, cur) { return (cur === 'USD' ? 'USD ' : 'TSh ') + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

// AMOUNT FIELDS: typing 1300000 shows 1,300,000 and is read as one million three hundred thousand
function parseMoney(v) { return parseFloat(String(v ?? '').replace(/,/g, '')) || 0; }
function formatMoney(n) {
    const num = Number(n);
    if (!isFinite(num) || num === 0) return '';
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function formatMoneyInput(el) {
    const old = el.value;
    const caret = el.selectionStart ?? old.length;
    const digitsBeforeCaret = old.slice(0, caret).replace(/[^\d]/g, '').length;

    let raw = old.replace(/[^\d.]/g, '');
    const parts = raw.split('.');
    let intPart = parts[0].replace(/^0+(?=\d)/, '');
    const decPart = parts.length > 1 ? '.' + parts.slice(1).join('').slice(0, 2) : '';
    el.value = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + decPart;

    if (document.activeElement === el) {
        let pos = 0, seen = 0;
        while (pos < el.value.length && seen < digitsBeforeCaret) {
            if (/\d/.test(el.value[pos])) seen++;
            pos++;
        }
        el.setSelectionRange(pos, pos);
    }
}
document.addEventListener('input', (e) => {
    if (e.target.classList && e.target.classList.contains('money-input')) formatMoneyInput(e.target);
}, true);

const IS_ADMIN_PAGE = /^\/admin\/?$/.test(location.pathname);
document.addEventListener('DOMContentLoaded', () => {
    if (IS_ADMIN_PAGE) {
        let ok = false;
        try { ok = !!localStorage.getItem('keyarch_token') && (JSON.parse(localStorage.getItem('keyarch_user') || '{}').role === 'SUPER_ADMIN'); } catch (e) { }
        if (ok) showAppView();
        else {
            document.getElementById('view-login').style.display = 'none';
            document.getElementById('view-admin-login').style.display = 'flex';
        }
    } else if (localStorage.getItem('keyarch_token')) showAppView();

    addGroupCard();
    calculateAmountDue();

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
        const propDropdown = document.getElementById('prop-dropdown-list');
        const propTrigger = document.getElementById('prop-dropdown-trigger');
        if (propDropdown && propTrigger && !propTrigger.contains(e.target) && !propDropdown.contains(e.target)) {
            propDropdown.classList.add('hidden');
        }

        const unitDropdown = document.getElementById('unit-dropdown-list');
        const unitTrigger = document.getElementById('unit-dropdown-trigger');
        if (unitDropdown && unitTrigger && !unitTrigger.contains(e.target) && !unitDropdown.contains(e.target)) {
            unitDropdown.classList.add('hidden');
        }
    });

    document.getElementById('form-admin-login').addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await fetch('/api/auth/admin-login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: document.getElementById('adm-email').value, password: document.getElementById('adm-password').value })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            localStorage.setItem('keyarch_token', data.token);
            localStorage.setItem('keyarch_user', JSON.stringify({ ...data.user, company: data.company }));
            document.getElementById('view-admin-login').style.display = 'none';
            showAppView();
        } else alert(data.error || 'Login Failed!');
    });

    document.getElementById('form-login').addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: document.getElementById('login-email').value,
                password: document.getElementById('login-password').value
            })
        });
        const data = await res.json();
        if (res.ok) {
            localStorage.setItem('keyarch_token', data.token);
            localStorage.setItem('keyarch_user', JSON.stringify({ ...data.user, company: data.company }));
            showAppView();
        } else if (LOCK_CODES.includes(data.code)) { showLockedScreen(data.error); }
        else alert(data.error || 'Login Failed!');
    });

    document.getElementById('form-portal-register').addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await fetch('/api/auth/register-company', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                company_name: document.getElementById('p-reg-company').value,
                admin_full_name: document.getElementById('p-reg-name').value,
                email: document.getElementById('p-reg-email').value,
                phone_number: document.getElementById('p-reg-phone').value,
                password: document.getElementById('p-reg-password').value,
                logo_data: regLogo || undefined
            })
        });
        const data = await res.json();
        if (res.ok) {
            alert('Your company has been registered.\n\nYour account will be activated after your payment is confirmed. For pricing and payment, contact HUGO TECH:\nWhatsApp +255 785 799 530\ninfo@hugotech.co.tz');
            switchAuthTab('login');
            document.getElementById('login-email').value = document.getElementById('p-reg-email').value;
            document.getElementById('form-portal-register').reset(); clearLogo('reg');
        } else {
            alert('Registration Failed: ' + (data.error || 'Server error'));
        }
    });

});

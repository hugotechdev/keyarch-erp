// SECURITY (Settings page): two-step sign-in, sign out everywhere, recent sign-ins, reset a colleague's 2FA
function secMsg(m) { if (window.kaToast) window.kaToast(m); else alert(m); }

async function secLoad() {
    const r = await api('/api/auth/security');
    if (!r.ok) return;
    const d = r.data, on = !!d.totp_enabled;
    const b = document.getElementById('sec-2fa-badge');
    b.textContent = on ? 'ON' : 'OFF';
    b.className = 'text-[10px] font-bold px-2 py-1 rounded-full ' + (on ? 'bg-emerald-600/30 text-emerald-300' : 'bg-gray-600/30 text-gray-300');
    document.getElementById('sec-2fa-on').classList.toggle('hidden', !on);
    document.getElementById('sec-2fa-off').classList.toggle('hidden', on);
    document.getElementById('sec-rec').textContent = d.recovery_left || 0;
    const ev = d.events || [];
    document.getElementById('sec-events').innerHTML = ev.length ? ev.map(e => {
        const t = new Date(e.created_at);
        const when = isNaN(t) ? '' : t.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const dev = secDevice(e.user_agent);
        return `<div class="flex items-center gap-2"><i class="fa-solid ${e.success ? 'fa-circle-check text-emerald-400' : 'fa-circle-xmark text-red-400'}"></i>
            <span class="w-28 shrink-0">${esc(when)}</span><span class="flex-1 truncate">${esc(dev)}</span><span class="text-gray-500">${esc(e.ip || '')}</span>
            <span class="${e.success ? 'text-emerald-300' : 'text-red-300'}">${e.success ? 'Signed in' : 'Failed'}</span></div>`;
    }).join('') : '<div class="text-gray-500">No sign-ins yet.</div>';
}
function secDevice(ua) {
    ua = String(ua || '');
    const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Device';
    const br = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : '';
    return os + (br ? ' · ' + br : '');
}

async function sec2faStart() {
    const pw = document.getElementById('sec-pw').value;
    if (!pw) return secMsg('Type your password first.');
    const r = await api('/api/auth/2fa/setup', 'POST', { password: pw });
    if (!r.ok) return secMsg(r.data.error || 'Could not start.');
    document.getElementById('sec-key').textContent = r.data.secret.replace(/(.{4})/g, '$1 ').trim();
    document.getElementById('sec-link').href = r.data.otpauth;
    document.getElementById('sec-2fa-step2').classList.remove('hidden');
    document.getElementById('sec-pw').value = '';
    document.getElementById('sec-code').focus();
}
async function sec2faEnable() {
    const r = await api('/api/auth/2fa/enable', 'POST', { code: document.getElementById('sec-code').value });
    if (!r.ok) return secMsg(r.data.error || 'Wrong code.');
    document.getElementById('sec-2fa-step2').classList.add('hidden');
    document.getElementById('sec-code').value = '';
    document.getElementById('sec-recovery-list').innerHTML = (r.data.recovery_codes || []).map(c => `<div>${esc(c)}</div>`).join('');
    document.getElementById('sec-recovery').classList.remove('hidden');
    await secLoad();
    secMsg('Two-step sign-in is on.');
}
async function sec2faDisable() {
    if (!confirm('Turn off two-step sign-in? Your account will be less safe.')) return;
    const r = await api('/api/auth/2fa/disable', 'POST', { password: document.getElementById('sec-off-pw').value, code: document.getElementById('sec-off-code').value });
    if (!r.ok) return secMsg(r.data.error || 'Could not turn off.');
    document.getElementById('sec-off-pw').value = ''; document.getElementById('sec-off-code').value = '';
    document.getElementById('sec-recovery').classList.add('hidden');
    await secLoad();
    secMsg('Two-step sign-in is off.');
}
async function secLogoutAll() {
    if (!confirm('Sign out on ALL devices, including this one?')) return;
    const r = await api('/api/auth/logout-all', 'POST', {});
    if (!r.ok) return secMsg(r.data.error || 'Could not sign out.');
    localStorage.removeItem('keyarch_token'); localStorage.removeItem('keyarch_user');
    window.location.reload();
}
async function secResetUser2fa() {
    const id = document.getElementById('us-id').value;
    if (!id) return;
    if (!confirm('Reset two-step sign-in for this person? They will also be signed out everywhere.')) return;
    const r = await api('/api/auth/2fa/reset-user', 'POST', { user_id: Number(id) });
    secMsg(r.ok ? (r.data.message || 'Done.') : (r.data.error || 'Could not reset.'));
}

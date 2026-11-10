// MOTION: small, light animations for the whole app. Switched off automatically for people who use "reduce motion".
// 1 numbers count up   2 page fade-in + list rows come in one by one   3 menu marker slides   4 shimmer while data loads
// 5 toast messages (replace alert)   6 save button flashes green   7 bell shakes   (chart bars, modals, hover lift = CSS in app.css)
(function () {
    var REDUCED = false;
    try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { }

    // ---------- 1. count-up ----------
    var NUM = /(\d[\d,]*(?:\.\d+)?)/g;
    function ease(t) { return 1 - Math.pow(1 - t, 3); }
    function fmt(v, dec, commas) { var s = v.toFixed(dec); if (commas) { var p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); } return s; }
    function countUp(el) {
        var text = el.textContent;
        if (!text || el._kaCur === text) return;                 // our own animation frame wrote this text
        if (REDUCED || !/\d/.test(text) || text.length > 40) { el._kaCur = text; return; }
        var parts = [], last = 0, m, finals = [];
        NUM.lastIndex = 0;
        while ((m = NUM.exec(text))) { parts.push(text.slice(last, m.index)); finals.push({ v: parseFloat(m[1].replace(/,/g, '')), dec: (m[1].split('.')[1] || '').length, commas: m[1].indexOf(',') >= 0 }); last = m.index + m[1].length; }
        parts.push(text.slice(last));
        if (!finals.some(function (f) { return f.v > 0; })) { el._kaCur = text; return; }
        var start = performance.now(), dur = 850; if (el._kaRaf) cancelAnimationFrame(el._kaRaf);
        (function step(now) {
            var t = Math.min(1, (now - start) / dur), k = ease(t), out = parts[0];
            finals.forEach(function (f, i) { out += fmt(f.v * k, f.dec, f.commas) + parts[i + 1]; });
            if (t >= 1) out = text;
            el._kaCur = out; el.textContent = out;
            if (t < 1) el._kaRaf = requestAnimationFrame(step);
        })(start);
    }
    function scanNums(root) {
        if (!root || !root.querySelectorAll) return;
        if (root.classList && root.classList.contains('ka-num')) countUp(root);
        root.querySelectorAll('.ka-num').forEach(countUp);
    }
    var numObs = new MutationObserver(function (recs) {
        recs.forEach(function (r) {
            var n = r.type === 'characterData' ? r.target.parentElement : (r.target.nodeType === 1 ? r.target : null);
            if (r.type === 'childList') r.addedNodes.forEach(function (a) { if (a.nodeType === 1) scanNums(a); });
            if (n) { var host = n.closest ? n.closest('.ka-num') : null; if (host) countUp(host); }
        });
    });

    // ---------- 2/3. page change: fade-in, list stagger, sliding menu marker ----------
    function moveMarker() {
        var act = document.querySelector('.nav-item.text-blue-300'); var nav = act && act.parentElement; if (!act || !nav) return;
        var mk = document.getElementById('ka-nav-marker');
        if (!mk) { mk = document.createElement('div'); mk.id = 'ka-nav-marker'; nav.style.position = nav.style.position || 'relative'; nav.appendChild(mk); }
        else if (mk.parentElement !== nav) nav.appendChild(mk);
        mk.style.height = act.offsetHeight * 0.6 + 'px';
        mk.style.transform = 'translateY(' + (act.offsetTop + act.offsetHeight * 0.2) + 'px)';
        mk.style.opacity = act.offsetHeight ? '1' : '0';
    }
    var loadingTimer = null;
    function pageShown(page) {
        var el = document.getElementById('page-' + page); if (!el) return;
        moveMarker();
        if (REDUCED) return;
        el.classList.remove('ka-enter'); void el.offsetWidth; el.classList.add('ka-enter');
        setTimeout(function () { el.classList.remove('ka-enter'); }, 1400);
        // shimmer on the cards until the first requests finish
        el.classList.add('ka-loading'); clearTimeout(loadingTimer);
        loadingTimer = setTimeout(function () { el.classList.remove('ka-loading'); }, 3000);
        waitIdle(function () { el.classList.remove('ka-loading'); });
    }
    var inflight = 0, idleCbs = [], idleT = null;
    function waitIdle(cb) { idleCbs.push(cb); checkIdle(); }
    function checkIdle() { clearTimeout(idleT); idleT = setTimeout(function () { if (inflight === 0) { var c = idleCbs; idleCbs = []; c.forEach(function (f) { f(); }); } }, 350); }
    (function hookFetch() {
        var f = window.fetch; if (!f) return;
        window.fetch = function () { inflight++; var p = f.apply(this, arguments); var done = function () { inflight = Math.max(0, inflight - 1); if (!inflight) checkIdle(); }; p.then(done, done); return p; };
    })();

    // ---------- 5/6. toast messages instead of alert() ----------
    var nativeAlert = window.alert ? window.alert.bind(window) : function () { };
    var BAD = /fail|error|invalid|cannot|can't|could not|couldn't|not allowed|denied|required|expired|unable|no connection|please|choose|select|enter|type delete|wrong|already|too (long|many|short)|must|missing|limit/i;
    var lastClick = null;
    document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('button'); if (b) lastClick = { el: b, t: Date.now() }; }, true);
    function toastBox() { var b = document.getElementById('ka-toasts'); if (!b) { b = document.createElement('div'); b.id = 'ka-toasts'; b.setAttribute('aria-live', 'polite'); document.body.appendChild(b); } return b; }
    function toast(msg) {
        var text = String(msg === undefined || msg === null ? '' : (msg.message || msg));
        // long texts, texts that are followed by a page reload, and texts with many lines stay as normal pop-ups so they are read
        if (REDUCED || text.length > 140 || text.indexOf('\n') >= 0 || /session has ended|registered|activated/i.test(text)) return nativeAlert(text);
        var bad = BAD.test(text), t = document.createElement('div');
        t.className = 'ka-toast ' + (bad ? 'ka-toast-bad' : 'ka-toast-ok');
        t.setAttribute('role', bad ? 'alert' : 'status');
        var ic = document.createElement('span'); ic.className = 'ka-toast-ic'; ic.textContent = bad ? '!' : '✓';
        var tx = document.createElement('span'); tx.className = 'ka-toast-tx'; tx.textContent = text;
        t.appendChild(ic); t.appendChild(tx);
        t.onclick = function () { t.classList.add('ka-toast-out'); setTimeout(function () { t.remove(); }, 250); };
        toastBox().appendChild(t);
        var life = bad ? 5200 : 2600; setTimeout(function () { t.onclick(); }, life);
        if (!bad && lastClick && Date.now() - lastClick.t < 4000 && document.contains(lastClick.el)) { var b = lastClick.el; b.classList.remove('ka-ok'); void b.offsetWidth; b.classList.add('ka-ok'); setTimeout(function () { b.classList.remove('ka-ok'); }, 1000); }
    }
    window.alert = toast;

    // ---------- 7. bell shakes when there is something urgent ----------
    var bellObs = null;
    function watchBell() {
        var c = document.getElementById('bell-count'); if (!c || bellObs) return;
        bellObs = new MutationObserver(function () {
            if (REDUCED || c.classList.contains('hidden')) return;
            var bell = c.parentElement; if (!bell) return; bell.classList.remove('ka-ring'); void bell.offsetWidth; bell.classList.add('ka-ring');
        });
        bellObs.observe(c, { childList: true, characterData: true, subtree: true });
    }

    // ---------- start ----------
    function boot() {
        numObs.observe(document.body, { subtree: true, childList: true, characterData: true });
        scanNums(document.body); watchBell();
        if (typeof window.showPage === 'function') {
            var orig = window.showPage;
            window.showPage = function (p) { var r = orig.apply(this, arguments); try { pageShown(p); } catch (e) { } return r; };
        }
        window.addEventListener('resize', moveMarker);
        setTimeout(moveMarker, 300);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    window.kaToast = toast;
})();

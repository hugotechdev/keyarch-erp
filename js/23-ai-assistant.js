// AI ASSISTANT chat window (Pro). Floating button at the bottom right; the answers come from /api/ai/chat (server/28-ai-assistant.js).
var AI = { open: false, busy: false, msgs: [], used: null, limit: null };

function aiAllowed() {
    try { return !!localStorage.getItem('keyarch_token') && role() !== 'SUPER_ADMIN' && role() !== 'MAINTENANCE_MANAGER' && hasFeature('ai'); } catch (e) { return false; }
}

// called after every login / feature refresh (see applyFeatureUI)
function aiRefresh() {
    var btn = document.getElementById('ai-fab');
    if (!aiAllowed()) { if (btn) btn.remove(); var p = document.getElementById('ai-panel'); if (p) p.remove(); AI.open = false; return; }
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'ai-fab'; btn.type = 'button'; btn.title = 'AI Assistant'; btn.setAttribute('aria-label', 'AI Assistant');
    btn.className = 'fixed z-40 bottom-4 right-4 w-14 h-14 rounded-full text-white text-xl flex items-center justify-center shadow-xl hover:scale-105 transition';
    btn.style.background = 'linear-gradient(135deg,#6366f1,#06b6d4)';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    btn.onclick = aiToggle;
    document.body.appendChild(btn);
}

function aiToggle() {
    AI.open = !AI.open;
    var p = document.getElementById('ai-panel');
    if (!AI.open) { if (p) p.classList.add('hidden'); return; }
    if (!p) aiBuild(); else p.classList.remove('hidden');
    aiLoadStatus(); aiPaint();
    setTimeout(function () { var i = document.getElementById('ai-input'); if (i) i.focus(); }, 50);
}

function aiBuild() {
    var p = document.createElement('div');
    p.id = 'ai-panel';
    p.className = 'fixed z-40 bottom-0 right-0 sm:bottom-20 sm:right-4 w-full sm:w-[400px] h-[85vh] sm:h-[560px] max-h-[100vh] flex flex-col bg-[#0d172d] border border-[#182848] sm:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden';
    p.innerHTML =
        '<div class="flex items-center gap-3 px-4 py-3 border-b border-[#182848]">' +
            '<div class="w-9 h-9 rounded-full flex items-center justify-center text-white" style="background:linear-gradient(135deg,#6366f1,#06b6d4)"><i class="fa-solid fa-wand-magic-sparkles"></i></div>' +
            '<div class="flex-1 min-w-0"><div class="text-sm font-black text-white">AI Assistant</div><div id="ai-usage" class="text-[10px] text-gray-500"></div></div>' +
            '<button type="button" onclick="aiClear()" title="New chat" class="text-gray-400 hover:text-white text-xs px-2 py-1 rounded-lg"><i class="fa-solid fa-rotate-right"></i></button>' +
            '<button type="button" onclick="aiToggle()" class="text-gray-400 hover:text-white px-2 py-1"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div id="ai-msgs" class="flex-1 overflow-y-auto p-4 space-y-3 text-xs"></div>' +
        '<form onsubmit="aiSend(event)" class="p-3 border-t border-[#182848] flex items-end gap-2">' +
            '<textarea id="ai-input" rows="1" maxlength="1500" placeholder="Ask about rent, tenants, units…" onkeydown="aiKey(event)" class="inp flex-1" style="resize:none;max-height:90px"></textarea>' +
            '<button id="ai-send" type="submit" class="w-10 h-10 shrink-0 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center"><i class="fa-solid fa-paper-plane"></i></button>' +
        '</form>' +
        '<div class="px-4 pb-2 text-[10px] text-gray-500">AI can make mistakes. Check important amounts in the app.</div>';
    document.body.appendChild(p);
}

function aiKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(e); } }
function aiClear() { if (AI.busy) return; AI.msgs = []; aiPaint(); }

async function aiLoadStatus() {
    var r = await api('/api/ai/status');
    if (r.ok) { AI.used = r.data.used; AI.limit = r.data.limit; AI.configured = r.data.configured; }
    aiUsage();
}
function aiUsage() {
    var el = document.getElementById('ai-usage'); if (!el) return;
    el.textContent = AI.used === null ? '' : (AI.limit === null ? AI.used + ' questions this month' : AI.used + ' / ' + AI.limit + ' questions this month');
}

// tiny, safe formatter: **bold**, "- " bullets, line breaks
function aiFormat(t) {
    var lines = esc(String(t || '')).split('\n'), out = '', inList = false;
    lines.forEach(function (ln) {
        var b = /^\s*[-•*]\s+(.*)$/.exec(ln);
        if (b) { if (!inList) { out += '<ul class="list-disc pl-4 space-y-0.5 my-1">'; inList = true; } out += '<li>' + b[1] + '</li>'; }
        else { if (inList) { out += '</ul>'; inList = false; } out += ln + '<br>'; }
    });
    if (inList) out += '</ul>';
    return out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(<br>)+$/, '');
}

function aiPaint() {
    var box = document.getElementById('ai-msgs'); if (!box) return;
    if (!AI.msgs.length) {
        var starters = ['Who has not paid this month?', 'Which leases end soon?', 'Which units are vacant?', 'How much did we collect this month?'];
        box.innerHTML = '<div class="text-gray-400 leading-relaxed">Hello! Ask me about rent, tenants, vacant units and money in your company.</div><div class="flex flex-wrap gap-2 pt-1">' +
            starters.map(function (s, i) { return '<button type="button" onclick="aiAsk(' + i + ')" class="px-3 py-1.5 rounded-full text-[11px] font-bold border bg-[#14223d] text-gray-200 border-[#233863] hover:border-indigo-500">' + s + '</button>'; }).join('') + '</div>';
        AI.starters = starters; return;
    }
    box.innerHTML = AI.msgs.map(function (m) {
        return m.role === 'user'
            ? '<div class="flex justify-end"><div class="max-w-[85%] px-3 py-2 rounded-2xl rounded-br-md bg-indigo-600 text-white whitespace-pre-wrap" data-ai-msg>' + esc(m.content) + '</div></div>'
            : '<div class="flex justify-start"><div class="max-w-[90%] px-3 py-2 rounded-2xl rounded-bl-md ' + (m.error ? 'bg-rose-900/30 text-rose-300' : 'bg-[#14223d] text-gray-100') + ' leading-relaxed" data-ai-msg>' + aiFormat(m.shown === undefined ? m.content : m.content.slice(0, m.shown)) + '</div></div>';
    }).join('') + (AI.busy ? '<div class="flex justify-start"><div class="px-3 py-2 rounded-2xl rounded-bl-md bg-[#14223d] text-gray-400"><i class="fa-solid fa-ellipsis fa-fade"></i></div></div>' : '');
    box.scrollTop = box.scrollHeight;
}

function aiAsk(i) { var s = (AI.starters || [])[i]; if (s) aiSend(null, s); }

async function aiSend(e, preset) {
    if (e && e.preventDefault) e.preventDefault();
    if (AI.busy) return;
    var inp = document.getElementById('ai-input');
    var text = (preset || (inp ? inp.value : '')).trim();
    if (!text) return;
    if (inp) { inp.value = ''; inp.style.height = ''; }
    AI.msgs.push({ role: 'user', content: text });
    AI.busy = true; aiPaint();
    var payload = AI.msgs.filter(function (m) { return !m.error; }).map(function (m) { return { role: m.role, content: m.content }; });
    var r = await api('/api/ai/chat', 'POST', { messages: payload, lang: (window.KA_LANG ? window.KA_LANG() : 'en') });
    AI.busy = false;
    if (r.ok) {
        var msg = { role: 'assistant', content: r.data.reply }; AI.msgs.push(msg); AI.used = r.data.used; AI.limit = r.data.limit; aiUsage();
        var calm = false; try { calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { }
        if (!calm && msg.content.length > 20) {   // the answer is written letter by letter (about 1.5 seconds at most)
            var step = Math.max(3, Math.ceil(msg.content.length / 40)); msg.shown = 0;
            var timer = setInterval(function () { msg.shown += step; if (msg.shown >= msg.content.length) { delete msg.shown; clearInterval(timer); } aiPaint(); }, 38);
        }
    }
    else AI.msgs.push({ role: 'assistant', content: (r.data && r.data.error) || 'Something went wrong. Please try again.', error: true });
    aiPaint();
}

'use strict';
/* GV Agent Core — web console */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* WhatsApp-style halki formatting: *bold* aur line breaks */
function fmt(s) {
  return esc(s).replace(/\*(.+?)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}
async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...(opts || {}) });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  return r;
}
const money = n => 'Rs ' + Number(n || 0).toLocaleString('en-PK');

/* ---------- tabs ---------- */
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(b => b.classList.remove('active'));
  $$('.view').forEach(v => v.classList.remove('active'));
  btn.classList.add('active');
  $('#view-' + btn.dataset.view).classList.add('active');
  if (btn.dataset.view === 'tasks') loadTasks();
  if (btn.dataset.view === 'dash') loadDash();
  if (btn.dataset.view === 'knowledge') loadKnowledge();
}));

/* ---------- header ---------- */
(async () => {
  try {
    const me = await (await api('/api/me')).json();
    $('#userName').textContent = me.username;
    const mode = await (await api('/api/agent/mode')).json();
    $('#modeBadge').textContent = 'brain: ' + mode.mode + (mode.mode === 'gemini' ? ' (' + mode.model + ')' : '');
    $('#modeBadge').title = mode.note || '';
  } catch (e) { /* redirected */ }
})();
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; });

/* ---------- agent chat ---------- */
const chatLog = $('#chatLog');
function addMsg(who, html, steps) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  let inner = '<div class="bubble">' + html;
  if (steps && steps.length) {
    inner += '<div class="steps">' + steps.map(s =>
      `<div class="step">${s.ok ? '✅' : '❌'} 🔧 <b>${esc(s.tool)}</b> — ${esc(s.summary || '')}</div>`).join('') + '</div>';
  }
  inner += '</div>';
  div.innerHTML = inner;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}
addMsg('agent', fmt('Assalam o Alaikum! Main *GV Agent* hoon. Command dein — main plan bana kar tools se kaam karke verify summary dunga.\nMisal: *aaj ki report do* · *new lead add karo: Ahmed, 03001234567, Ahmed Shoes, Lahore, Fashion* · *madad*'));

$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addMsg('staff', fmt(text));
  const typing = addMsg('agent', '<span class="muted">Agent kaam kar raha hai…</span>');
  try {
    const out = await (await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ message: text }) })).json();
    typing.remove();
    addMsg('agent', fmt(out.reply || out.error || '—'), out.steps);
  } catch (err) {
    typing.remove();
    addMsg('agent', 'Error: ' + esc(err.message));
  }
});
$('#chatReset').addEventListener('click', async () => {
  await api('/api/agent/reset', { method: 'POST' });
  chatLog.innerHTML = '';
  addMsg('agent', 'Conversation reset ho gayi. Nayi command dein.');
});

/* ---------- tasks ---------- */
async function loadTasks() {
  const list = await (await api('/api/tasks?limit=100')).json();
  const tb = $('#tasksTable tbody');
  tb.innerHTML = list.map(t => `<tr data-id="${t.id}">
    <td>${new Date(t.createdAt).toLocaleString('en-PK')}</td>
    <td>${esc(t.channel)}</td>
    <td class="cmd">${esc((t.input || '').slice(0, 70))}</td>
    <td>${esc(t.brain)}</td>
    <td>${(t.toolCalls || []).length}</td>
    <td><span class="badge st-${esc(t.status)}">${esc(t.status)}</span></td></tr>`).join('') ||
    '<tr><td colspan="6" class="muted">Abhi koi task nahi — Agent Chat se pehli command dein.</td></tr>';
  tb.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => showTask(tr.dataset.id)));
}
async function showTask(id) {
  const t = await (await api('/api/tasks/' + encodeURIComponent(id))).json();
  const el = $('#taskDetail');
  el.classList.remove('hidden');
  el.innerHTML = `<h3>Task ${esc(t.id)}</h3>
    <p class="muted">${new Date(t.createdAt).toLocaleString('en-PK')} · channel: ${esc(t.channel)} · staff: ${esc(t.staffId)} · brain: ${esc(t.brain)} · status: <b>${esc(t.status)}</b></p>
    <p><b>Command:</b> ${esc(t.input)}</p>
    <h4>Tool calls (${(t.toolCalls || []).length})</h4>
    ${(t.toolCalls || []).map(s => `<div class="step">${s.ok ? '✅' : '❌'} 🔧 <b>${esc(s.tool)}</b> <code>${esc(JSON.stringify(s.args || {}))}</code><br><span class="muted">${esc(s.summary || '')}${s.error ? ' · error: ' + esc(s.error) : ''}</span></div>`).join('') || '<p class="muted">Is task me koi tool nahi chala.</p>'}
    <h4>Final summary</h4><div class="summary">${fmt(t.finalSummary || '')}</div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#tasksRefresh').addEventListener('click', loadTasks);

/* ---------- dashboard ---------- */
async function loadDash() {
  const d = await (await api('/api/dashboard')).json();
  const fu = await (await api('/api/followups?status=open')).json().catch(() => []);
  $('#statCards').innerHTML = [
    ['Total Leads', d.totalLeads], ['Revenue', money(d.revenue)],
    ['Paid Features', d.paidCount], ['Published Posts', d.publishedCount],
    ['Nayi Leads Aaj', d.newToday], ['Open Follow-ups', Array.isArray(fu) ? fu.length : d.openFollowups || 0]
  ].map(([k, v]) => `<div class="card stat"><div class="stat-v">${v}</div><div class="stat-k">${k}</div></div>`).join('');
  $('#stageTable').innerHTML = Object.entries(d.counts).map(([s, c]) =>
    `<div class="stage-row"><span>${esc(s.replace(/_/g, ' '))}</span><b>${c}</b></div>`).join('');
  $('#taskList').innerHTML = (d.tasks.length
    ? d.tasks.map(t => `<div class="task-item">${esc(t.label)}</div>`).join('')
    : '<p class="muted">Koi pending task nahi.</p>');
  $('#recentLeads').innerHTML = (d.recent.length
    ? '<table><thead><tr><th>Business</th><th>Contact</th><th>City</th><th>Stage</th><th>Payment</th></tr></thead><tbody>' +
      d.recent.map(l => `<tr><td>${esc(l.business || l.name)}</td><td>${esc(l.name)} · ${esc(l.phone || '')}</td><td>${esc(l.city || '')}</td><td>${esc(l.stage)}</td><td>${l.payment && l.payment.confirmed ? money(l.payment.amount) + ' (' + esc(l.invoiceNo) + ')' : '—'}</td></tr>`).join('') + '</tbody></table>'
    : '<p class="muted">Abhi koi lead nahi.</p>');
}
$('#dashRefresh').addEventListener('click', loadDash);

/* ---------- sales test ---------- */
const salesLog = $('#salesLog');
function addSales(who, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (who === 'lead' ? 'staff' : 'agent');
  div.innerHTML = '<div class="bubble">' + fmt(text) + '</div>';
  salesLog.appendChild(div);
  salesLog.scrollTop = salesLog.scrollHeight;
}
$('#salesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#salesInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addSales('lead', text);
  const out = await (await api('/api/sales/chat', { method: 'POST', body: JSON.stringify({ sessionId: 'console-sales', message: text }) })).json();
  (out.replies || []).forEach(r => addSales('agent', r));
  if (out.leadId) addSales('agent', '(System: lead ban gayi — ID ' + out.leadId + ', Dashboard/Pipeline me dekhein)');
});
$('#salesReset').addEventListener('click', async () => {
  await api('/api/sales/reset', { method: 'POST', body: JSON.stringify({ sessionId: 'console-sales' }) });
  salesLog.innerHTML = '';
});

/* ---------- knowledge ---------- */
async function loadKnowledge() {
  const k = await (await api('/api/knowledge')).json();
  const f = $('#knowledgeForm');
  f.businessName.value = k.businessName || '';
  f.agentName.value = k.agentName || '';
  f.salesAgentName.value = k.salesAgentName || '';
  f.packageName.value = (k.package || {}).name || '';
  f.packagePrice.value = (k.package || {}).price || '';
  f.deliveryDays.value = (k.package || {}).deliveryDays || '';
  f.inclusions.value = ((k.package || {}).inclusions || []).join('\n');
  f.paymentInstructions.value = k.paymentInstructions || '';
  f.behaviourRules.value = (k.behaviourRules || []).join('\n');
}
$('#knowledgeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    businessName: f.businessName.value, agentName: f.agentName.value, salesAgentName: f.salesAgentName.value,
    paymentInstructions: f.paymentInstructions.value,
    behaviourRules: f.behaviourRules.value.split('\n').map(s => s.trim()).filter(Boolean),
    package: {
      name: f.packageName.value, price: Number(f.packagePrice.value),
      deliveryDays: f.deliveryDays.value,
      inclusions: f.inclusions.value.split('\n').map(s => s.trim()).filter(Boolean)
    }
  };
  await api('/api/knowledge', { method: 'PUT', body: JSON.stringify(body) });
  $('#knowledgeMsg').textContent = 'Save ho gaya — ' + new Date().toLocaleTimeString('en-PK');
});

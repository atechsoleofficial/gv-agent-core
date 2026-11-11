'use strict';
/* Agent Core v2 — Cloudflare Workers entry (Node server.js ka port).
   Channels: Web console (staff commands + tasks), WhatsApp webhook (staff → agent brain,
   leads → sales agent), Cron Triggers (daily report + follow-up reminders).
   Storage: Workers KV (binding GV_KV) — keys: db, knowledge, outbox.
   Console UI: Workers Static Assets (binding ASSETS, public/ folder). */
import { KvStore } from './store.js';
import { compatSettings } from './knowledge.js';
import * as svc from './services.js';
import * as content from './content.js';
import * as salesAgent from './salesAgent.js';
import * as brain from './agent.js';
import * as wa from './whatsapp.js';
import * as scheduler from './scheduler.js';
import { makeSessionValue, verifySessionValue, parseCookies } from './session.js';
import { digits } from './textutil.js';

const adminUser = env => env.ADMIN_USER || 'admin';
const adminPass = env => env.ADMIN_PASS || 'change-me';

/* ---------------- response helpers ---------------- */
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}
function text(body, status = 200, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  return new Response(body, { status, headers: { 'Content-Type': contentType, ...extraHeaders } });
}
function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/* Node express.json + urlencoded dono accept karta tha — yahan dono ki koshish. */
async function readBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  try {
    if (ct.includes('application/json')) return await request.json();
    if (ct.includes('form')) {
      const fd = await request.formData();
      const out = {};
      for (const [k, v] of fd.entries()) out[k] = v;
      return out;
    }
    const t = await request.text();
    if (!t) return {};
    try { return JSON.parse(t); } catch (e) { return {}; }
  } catch (e) { return {}; }
}

async function currentUser(request, env) {
  const sid = parseCookies(request).ac_sid;
  if (!sid) return null;
  const username = await verifySessionValue(env, sid);
  return username ? { username } : null;
}

/* ---------------- lead sales agent (shared: test console + WhatsApp) ---------------- */
async function handleSalesMessage(S, env, sessionId, text, phoneHint) {
  const d = S.data;
  if (!d.agentSessions[sessionId]) d.agentSessions[sessionId] = { step: 'start', data: {}, history: [], leadId: null };
  const session = d.agentSessions[sessionId];
  if (phoneHint && !session.data.phone) session.data.phone = phoneHint;
  const settings = compatSettings(S);
  const ctx = {
    S, env, db: d, settings, session, text,
    upsertLeadFromSession(sess) {
      let lead = sess.leadId ? svc.getLead(S, sess.leadId) : null;
      if (!lead) {
        lead = svc.createLead(S, {
          name: sess.data.name || sess.data.business,
          business: sess.data.business, city: sess.data.city, category: sess.data.category,
          phone: sess.data.phone || '', source: 'whatsapp', stage: 'payment_awaited',
          notes: 'WhatsApp Sales Agent se bani lead'
        });
        sess.leadId = lead.id;
      } else {
        lead.stage = 'payment_awaited'; svc.touch(lead);
      }
      lead.conversation = sess.history;
      S.save();
      return lead;
    }
  };
  const out = await salesAgent.handleMessage(ctx);
  if (session.leadId) {
    const lead = svc.getLead(S, session.leadId);
    if (lead) lead.conversation = session.history;
  }
  S.save();
  await S.persist();
  return { replies: out.replies, step: session.step, leadId: session.leadId || null };
}

/* ---------------- WhatsApp webhook processing ---------------- */
async function processWebhook(S, env, body) {
  const entries = (body && body.entry) || [];
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      const value = change.value || {};
      for (const msg of (value.messages || [])) {
        const from = msg.from;
        if (!from) continue;
        const staff = wa.isStaffNumber(env, from);
        if (msg.type !== 'text' || !msg.text || !msg.text.body) {
          // Voice note / media — graceful handling (Node jaisa hi text)
          const note = msg.type === 'audio'
            ? (staff
                ? 'Voice note mil gayi hai, lekin main voice abhi sun (transcribe) nahi sakta. Meherbani karke command text me likh kar bhej dein — misal: "aaj ki report do".'
                : 'Assalam o Alaikum! Aap ki voice note mil gayi hai, lekin main abhi voice sun nahi sakta. Meherbani karke apna message text me likh kar bhej dein, main foran jawab dunga.')
            : (staff
                ? 'Ye attachment main process nahi kar sakta — command text me likh kar bhej dein.'
                : 'Assalam o Alaikum! Meherbani karke apna message text me likh kar bhej dein, main foran jawab dunga.');
          await wa.sendWhatsApp(S, env, from, note);
          continue;
        }
        const msgText = msg.text.body;
        if (staff) {
          const out = await brain.runCommand({ S, env, staffId: 'wa:' + digits(from), channel: 'whatsapp', text: msgText });
          await wa.sendWhatsApp(S, env, from, out.reply);
        } else {
          const out = await handleSalesMessage(S, env, 'wa-sales-' + digits(from), msgText, from);
          for (const r of out.replies) await wa.sendWhatsApp(S, env, from, r);
        }
      }
    }
  }
  await S.persist();
}

/* ---------------- API router (auth ke andar) ---------------- */
async function handleApi(request, env, url, user) {
  const path = url.pathname;
  const method = request.method;
  const needStore = !(method === 'POST' && (path === '/api/login' || path === '/api/logout'));

  /* login / logout — store ki zaroorat nahi */
  if (method === 'POST' && path === '/api/login') {
    const body = await readBody(request);
    const { username, password } = body || {};
    if (username === adminUser(env) && password === adminPass(env)) {
      const value = await makeSessionValue(env, username);
      return json({ ok: true, username }, 200, {
        'Set-Cookie': `ac_sid=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`
      });
    }
    return json({ error: 'Galat username ya password' }, 401);
  }
  if (method === 'POST' && path === '/api/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': 'ac_sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  if (!user) return json({ error: 'Not logged in' }, 401);
  if (!needStore) return json({ error: 'Not found' }, 404);

  const S = await KvStore.load(env.GV_KV);
  const db = () => S.data;
  const knowledge = () => S.knowledge;

  /* agent brain APIs */
  if (method === 'GET' && path === '/api/agent/mode') {
    const mode = brain.brainMode(env);
    return json({
      mode, model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      note: mode === 'gemini' ? 'Gemini function-calling active' : 'GEMINI_API_KEY set nahi — deterministic fallback planner active (saare tools chalte hain)'
    });
  }
  if (method === 'POST' && path === '/api/agent/chat') {
    try {
      const body = await readBody(request);
      const out = await brain.runCommand({
        S, env,
        staffId: 'web:' + user.username,
        channel: 'web',
        text: (body && body.message) || ''
      });
      return json({ taskId: out.task.id, reply: out.reply, steps: out.steps, status: out.status, brain: out.brain });
    } catch (e) {
      console.error('agent chat error', e);
      return json({ error: 'Agent me masla aya, dobara try karein' }, 500);
    }
  }
  if (method === 'POST' && path === '/api/agent/reset') {
    delete db().staffMemory['web:' + user.username];
    S.save();
    await S.persist();
    return json({ ok: true });
  }

  /* task log */
  if (method === 'GET' && path === '/api/tasks') {
    const list = [...db().tasks].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return json(list.slice(0, Number(url.searchParams.get('limit')) || 100));
  }
  const taskMatch = path.match(/^\/api\/tasks\/(.+)$/);
  if (method === 'GET' && taskMatch) {
    const t = db().tasks.find(x => x.id === decodeURIComponent(taskMatch[1]));
    if (!t) return json({ error: 'Task nahi mila' }, 404);
    return json(t);
  }

  /* funnel read APIs */
  if (method === 'GET' && path === '/api/me') return json({ username: user.username });
  if (method === 'GET' && path === '/api/dashboard') return json(svc.dashboardData(S));
  if (method === 'GET' && path === '/api/leads') return json(db().leads);
  if (method === 'GET' && path === '/api/platforms') return json(db().platforms);
  if (method === 'GET' && path === '/api/followups') return json(svc.listFollowups(S, url.searchParams.get('status') || undefined));
  if (method === 'GET' && path === '/api/outbox') return json(wa.readOutbox(S).slice(-50));

  /* knowledge / settings */
  if (method === 'GET' && path === '/api/knowledge') return json(knowledge());
  if (method === 'PUT' && path === '/api/knowledge') {
    const k = knowledge();
    const b = (await readBody(request)) || {};
    if (typeof b.businessName === 'string' && b.businessName.trim()) k.businessName = b.businessName.trim();
    if (typeof b.agentName === 'string' && b.agentName.trim()) k.agentName = b.agentName.trim();
    if (typeof b.salesAgentName === 'string' && b.salesAgentName.trim()) k.salesAgentName = b.salesAgentName.trim();
    if (typeof b.paymentInstructions === 'string') k.paymentInstructions = b.paymentInstructions;
    if (b.package && typeof b.package === 'object') {
      if (typeof b.package.name === 'string' && b.package.name.trim()) k.package.name = b.package.name.trim();
      if (b.package.price !== undefined && !isNaN(Number(b.package.price))) k.package.price = Number(b.package.price);
      if (Array.isArray(b.package.inclusions)) k.package.inclusions = b.package.inclusions.map(String);
      if (typeof b.package.deliveryDays === 'string') k.package.deliveryDays = b.package.deliveryDays;
    }
    if (Array.isArray(b.behaviourRules)) k.behaviourRules = b.behaviourRules.map(String);
    S.saveKnowledge();
    await S.persist();
    return json(k);
  }

  /* lead sales agent (test console) */
  if (method === 'POST' && path === '/api/sales/chat') {
    try {
      const body = await readBody(request);
      const out = await handleSalesMessage(S, env, (body && body.sessionId) || 'console-sales', (body && body.message) || '');
      return json(out);
    } catch (e) {
      console.error('sales agent error', e);
      return json({ error: 'Sales agent me masla aya' }, 500);
    }
  }
  if (method === 'POST' && path === '/api/sales/reset') {
    const body = await readBody(request);
    delete db().agentSessions[(body && body.sessionId) || 'console-sales'];
    S.save();
    await S.persist();
    return json({ ok: true });
  }

  /* design download + invoice */
  const designMatch = path.match(/^\/api\/leads\/(.+)\/design\/(.+)$/);
  if (method === 'GET' && designMatch) {
    const l = svc.getLead(S, decodeURIComponent(designMatch[1]));
    const platformId = decodeURIComponent(designMatch[2]);
    if (!l || !l.content || !l.content.designs[platformId]) return text('Design nahi mila', 404);
    return new Response(l.content.designs[platformId], {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Content-Disposition': `attachment; filename="design-${(l.business || 'lead').replace(/\s+/g, '-')}-${platformId}.svg"`
      }
    });
  }
  const invoiceMatch = path.match(/^\/api\/leads\/(.+)\/invoice$/);
  if (method === 'GET' && invoiceMatch) {
    const l = svc.getLead(S, decodeURIComponent(invoiceMatch[1]));
    if (!l || !l.payment || !l.payment.confirmed) return text('Invoice sirf paid lead ke liye hai', 404);
    const k = knowledge();
    const dt = new Date(l.payment.at).toLocaleDateString('en-PK');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${l.invoiceNo}</title>
<style>body{font-family:Arial,sans-serif;max-width:720px;margin:40px auto;color:#222}h1{color:#0b3d2e}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{border:1px solid #ccc;padding:10px;text-align:left}.r{text-align:right}.tot{font-weight:bold;background:#f4f8f6}@media print{button{display:none}}</style></head>
<body><button onclick="window.print()">Print / Save PDF</button>
<h1>${content.esc(k.businessName)}</h1><p>Agent Core — Invoice</p>
<p><b>Invoice No:</b> ${l.invoiceNo}<br><b>Date:</b> ${dt}<br><b>Billed to:</b> ${content.esc(l.name)} (${content.esc(l.business)}, ${content.esc(l.city)})<br><b>WhatsApp:</b> ${content.esc(l.phone)}</p>
<table><tr><th>Description</th><th class="r">Amount (PKR)</th></tr>
<tr><td>${content.esc(k.package.name)} — feature on all 4 platforms<br><small>${content.esc(k.package.inclusions.join(', '))}</small></td><td class="r">${Number(l.payment.amount).toLocaleString('en-PK')}</td></tr>
<tr class="tot"><td>Total Paid (${content.esc(l.payment.method)}${l.payment.reference ? ' — Ref: ' + content.esc(l.payment.reference) : ''})</td><td class="r">Rs ${Number(l.payment.amount).toLocaleString('en-PK')}</td></tr></table>
<p style="margin-top:30px">Shukriya! — Team ${content.esc(k.businessName)}</p></body></html>`;
    return text(html, 200, 'text/html; charset=utf-8');
  }

  return json({ error: 'Not found' }, 404);
}

/* ---------------- static assets ---------------- */
const PUBLIC_FILES = new Set(['/index.html', '/login.html', '/style.css', '/app.js']);
async function serveAsset(env, request, pathname) {
  if (!env.ASSETS) return null;
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  const r = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
  return r.status === 200 ? r : null;
}

/* ---------------- entry ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    /* WhatsApp webhook (auth se bahir) */
    if (path === '/webhooks/whatsapp' && method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token && env.WHATSAPP_VERIFY_TOKEN && token === env.WHATSAPP_VERIFY_TOKEN) {
        return text(challenge || '', 200);
      }
      return text('Verification failed', 403);
    }
    if (path === '/webhooks/whatsapp' && method === 'POST') {
      const body = await readBody(request);
      /* Node pehle 200 bhejta tha, processing baad me — yahan waitUntil me wahi behaviour. */
      ctx.waitUntil((async () => {
        try {
          const S = await KvStore.load(env.GV_KV);
          await processWebhook(S, env, body);
        } catch (e) { console.error('webhook error', e); }
      })());
      return text('', 200);
    }

    /* API */
    if (path.startsWith('/api/')) {
      const user = await currentUser(request, env);
      return handleApi(request, env, url, user);
    }

    /* Static + console shell (GET only) */
    if (method === 'GET') {
      const user = await currentUser(request, env);
      if (path === '/') {
        if (!user) return redirect('/login.html');
        const r = await serveAsset(env, request, '/index.html');
        return r || text('index.html asset nahi mila', 500);
      }
      if (PUBLIC_FILES.has(path)) {
        const r = await serveAsset(env, request, path);
        if (r) return r;
      } else {
        const r = await serveAsset(env, request, path);
        if (r) return r;
      }
      /* Node catch-all: logged-in ho to SPA index, warna login page */
      if (user) {
        const r = await serveAsset(env, request, '/index.html');
        return r || text('index.html asset nahi mila', 500);
      }
      return redirect('/login.html');
    }

    return text('Not found', 404);
  },

  /* Cron Triggers — wrangler.toml: daily "0 4 * * *" (04:00 UTC = 09:00 PKT), hourly "5 * * * *" */
  async scheduled(event, env, ctx) {
    const work = (async () => {
      try {
        const S = await KvStore.load(env.GV_KV);
        if (event.cron === '0 4 * * *') {
          await scheduler.dailyReport(S, env, 'cron ' + scheduler.reportTimeLabel(env) + ' PKT');
        }
        await scheduler.followupScan(S, env);
        await S.persist();
      } catch (e) {
        console.error('scheduled error', e);
      }
    })();
    ctx.waitUntil(work);
    return work;
  }
};

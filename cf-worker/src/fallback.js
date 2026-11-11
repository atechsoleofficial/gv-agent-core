'use strict';
/* FALLBACK PLANNER — jab GEMINI_API_KEY na ho to ye deterministic planner chalta hai.
   Node lib/fallback.js se faithful port — logic aur texts bilkul wahi hain,
   sirf imports ESM hain aur store constants src/store.js se aate hain. */
import { STAGES, STAGE_LABEL } from './store.js';
import * as tools from './tools.js';
import { isYes, isNo, stripYesPrefix, money } from './textutil.js';

const SL = STAGE_LABEL;
const STAGE_ALIASES = [
  ['payment_awaited', ['payment awaited', 'payment pending', 'payment walay', 'payment wale']],
  ['payment_confirmed', ['payment confirmed', 'paid walay', 'paid wale']],
  ['material_pending', ['material pending', 'material walay']],
  ['content_ready', ['content ready', 'content walay']],
  ['approved', ['approved']],
  ['published', ['published', 'publish ho gaye', 'publish walay']],
  ['reported', ['reported', 'report ho gaye']],
  ['talking', ['talking', 'baat ho rahi']],
  ['new', ['new', 'naye', 'nayi']]
];

export function helpText() {
  return `Main ye kaam kar sakta hoon (tools ke zariye, har step verify karke):\n\n` +
    `• *aaj ki report do* — leads, payments, published, tasks, follow-ups\n` +
    `• *new lead add karo: Ahmed, 03001234567, Ahmed Shoes, Lahore, Fashion*\n` +
    `• *leads dikhao* / *payment awaited walay leads dikhao*\n` +
    `• *<business> ka status batao*\n` +
    `• *<business> ka material complete kar do* — phir *<business> ka content banao*\n` +
    `• *<business> ki payment confirm karo JazzCash TID123* — pehle main confirm karunga, aap "yes" bolen ge to lagegi\n` +
    `• *<business> ko approve karo* — publish queue (ye bhi confirmation ke baad)\n` +
    `• *<business> ki report bhejo* · *<business> ko talking me dalo*\n` +
    `• *<business> par follow-up lagao: kal material mangwana hai* · *follow-ups dikhao*\n` +
    `• *platforms dikhao* · *package ki tafseel batao*\n\nNaam se zyada leads milein to main list de kar poochunga, guess nahi karunga.`;
}

function leadLine(s) {
  return `• *${s.business || s.name}* (${s.name || '—'}, ${s.city || '—'}) — ${s.stageLabel || SL[s.stage] || s.stage} · ID: ${s.id}`;
}
function clipArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = (typeof v === 'string' && v.length > 90) ? v.slice(0, 90) + '…' : v;
  }
  return out;
}

const REQUIRED = [['name', 'contact ka *naam* kya hai?'], ['phone', 'us ka *WhatsApp number* kya hai?'], ['business', '*business* ka naam kya hai?']];
function parseNewLeadFields(text) {
  const out = {};
  const kv = /(naam|name|phone|mobile|business|city|sheher|category)\s*[:=]\s*([^,]+)/gi;
  let m, anyKv = false;
  while ((m = kv.exec(text))) {
    anyKv = true;
    const k = m[1].toLowerCase();
    const key = (k === 'naam') ? 'name' : (k === 'mobile') ? 'phone' : (k === 'sheher') ? 'city' : k;
    out[key] = m[2].trim();
  }
  if (anyKv) return out;
  let rest = text.replace(/.*?add karo\s*:?\s*/i, '');
  if (rest === text) rest = text.replace(/^(new lead|lead)\s*/i, '');
  const parts = rest.split(',').map(s => s.trim()).filter(Boolean);
  const keys = ['name', 'phone', 'business', 'city', 'category'];
  parts.forEach((p, i) => { if (keys[i]) out[keys[i]] = p; });
  return out;
}

/**
 * Execute one staff command through the fallback planner.
 * mem = persisted per-staff memory {pendingAction, pendingPick, collecting}
 * steps = array to append tool traces {tool, args, ok, error?, summary}
 * Returns { finalText, awaiting: bool }
 */
export async function execute(ctx, mem, rawText, steps, depth = 0) {
  const text = String(rawText || '').trim();
  const t = text.toLowerCase();
  const T = async (name, args) => {
    const r = await tools.runTool(ctx, name, args || {});
    steps.push({ tool: name, args: clipArgs(args), ok: !!r.ok, error: r.error || undefined, summary: r.summary || '', at: new Date().toISOString() });
    return r;
  };
  const done = (finalText, awaiting = false) => ({ finalText, awaiting });

  /* ---------- 1) pending sensitive action ki confirmation ---------- */
  if (mem.pendingAction) {
    const action = mem.pendingAction;
    if (isYes(text)) {
      mem.pendingAction = null;
      const r = await T(action.tool, action.args);
      let out = r.ok ? `Ho gaya — verified:\n${r.summary}` : `Action nahi ho saka: ${r.summary}`;
      const leadId = action.args && action.args.leadId;
      if (r.ok && leadId) {
        const v = await T('get_lead_detail', { leadId });
        if (v.ok) out += `\nDobara parh kar verify kiya — stage ab: *${v.data.stageLabel}*${v.data.payment && v.data.payment.confirmed ? `, payment: ${money(v.data.payment.amount)} via ${v.data.payment.method}, Invoice: ${v.data.payment.invoiceNo}` : ''}.`;
      }
      const rest = stripYesPrefix(text);
      if (rest && rest.length > 3 && depth < 2) {
        const more = await execute(ctx, mem, rest, steps, depth + 1);
        return done(out + '\n\n' + more.finalText, more.awaiting);
      }
      return done(out);
    }
    if (isNo(text)) {
      mem.pendingAction = null;
      return done('Theek hai, pending action cancel kar diya. Kuch aur ho to bata dein.');
    }
    return done(`Aik action aap ki confirmation ka wait kar raha hai:\n${action.description}\n\nAge barhne ke liye *yes / confirm* likhein, ya *cancel*.`, true);
  }

  /* ---------- 2) ambiguous pick ---------- */
  if (mem.pendingPick) {
    if (isNo(text)) { mem.pendingPick = null; return done('Cancel kar diya.'); }
    const n = parseInt(text, 10);
    const pick = mem.pendingPick;
    if (!isNaN(n) && n >= 1 && n <= pick.matches.length) {
      mem.pendingPick = null;
      const leadId = pick.matches[n - 1];
      const txt = await runLeadIntent(ctx, mem, T, pick.intent.kind, leadId, pick.intent.extra || {});
      return done(txt, !!mem.pendingAction);
    }
    return done('Number se select karein (list me se aik), ya *cancel* likh dein.', true);
  }

  /* ---------- 3) new-lead field collection ---------- */
  if (mem.collecting) {
    if (isNo(text)) { mem.collecting = null; return done('Cancel kar diya.'); }
    const c = mem.collecting;
    c.data[REQUIRED[c.step][0]] = text;
    c.step += 1;
    while (c.step < REQUIRED.length && c.data[REQUIRED[c.step][0]]) c.step += 1;
    if (c.step < REQUIRED.length) return done('Noted. Ab ' + REQUIRED[c.step][1], true);
    const data = c.data; mem.collecting = null;
    const r = await T('create_lead', { ...data, source: 'manual' });
    return done(r.ok
      ? `Nayi lead ban gayi — verified:\n${leadLine(r.data)}\n• Phone: ${r.data.phone}\n• Category: ${r.data.category || '—'}\nAb isay pipeline me age barha sakte hain.`
      : 'Lead nahi ban saki: ' + r.summary);
  }

  /* ---------- 4) help / greeting ---------- */
  if (/\b(madad|help|commands?|kia kar sakte|kya kar sakte|menu)\b/i.test(t)) return done(helpText());
  if (/^(salam|assalam|hi|hello|hey|aoa)\b/i.test(t) && t.length < 25) {
    return done('Walaikum Assalam! Main GV Agent hoon — funnel ke saare kaam tools se karke report deta hoon. *madad* likhein to saari commands dikha dun, ya seedha kaam bolein, misal: "aaj ki report do".');
  }

  /* ---------- 5) report ---------- */
  if (/(report|summary|hisab)/i.test(t) && !/ki report (bhejo|generate)/i.test(t)) {
    const r = await T('get_daily_report', {});
    const fu = await T('list_followups', { status: 'open' });
    const dash = r.data;
    const stageLines = STAGES.map(s => `• ${SL[s]}: ${dash.counts[s]}`).join('\n');
    const taskLines = dash.tasks.length ? dash.tasks.slice(0, 8).map(x => `• ${x.label}`).join('\n') : '• Koi pending task nahi';
    return done(`*Aaj ki report — ${new Date().toLocaleDateString('en-PK')}*\n\n` +
      `Nayi leads aaj: *${dash.newToday}* · Kul leads: *${dash.totalLeads}*\n` +
      `Payments (kul revenue): *${money(dash.revenue)}* (${dash.paidCount} paid features)\n` +
      `Published posts: *${dash.publishedCount}* · Open follow-ups: *${fu.ok ? fu.data.count : 0}*\n\n*Stage counts:*\n${stageLines}\n\n*Pending tasks (${dash.tasks.length}):*\n${taskLines}`);
  }

  /* ---------- 6) follow-ups list ---------- */
  if (/(follow[-\s]?ups? dikhao|follow[-\s]?up list|followups batao)/i.test(t)) {
    const r = await T('list_followups', { status: 'open' });
    if (!r.ok || !r.data.count) return done('Abhi koi open follow-up nahi hai.');
    return done(`*Open follow-ups (${r.data.count}):*\n` + r.data.followups.map(f => `• ${f.title}${f.dueAt ? ' — due: ' + String(f.dueAt).slice(0, 10) : ''} · ID: ${f.id}`).join('\n'));
  }

  /* ---------- 7) new lead ---------- */
  if (/(new lead|nayi lead|lead add|lead banao|add karo)/i.test(t) && /lead/i.test(t)) {
    const data = parseNewLeadFields(text);
    const missing = REQUIRED.filter(([k]) => !data[k]);
    if (missing.length) {
      mem.collecting = { data, step: 0 };
      while (mem.collecting.step < REQUIRED.length && data[REQUIRED[mem.collecting.step][0]]) mem.collecting.step++;
      return done(`Lead banata hoon — kuch maloomat reh gayi hai. Pehle ye bata dein: ${REQUIRED[mem.collecting.step][1]}` +
        (data.business || data.name ? `\n(Jo diya wo save hai: ${Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''), true);
    }
    const r = await T('create_lead', { ...data, source: 'manual' });
    return done(r.ok ? `Nayi lead ban gayi — verified:\n${leadLine(r.data)}\n• Phone: ${r.data.phone}\n• Category: ${r.data.category || '—'}` : 'Lead nahi ban saki: ' + r.summary);
  }

  /* ---------- 8) list leads ---------- */
  if (/(leads dikhao|lead dikhao|list karo|saari leads|sari leads|leads batao)/i.test(t)) {
    let stageFilter = null;
    for (const [stage, aliases] of STAGE_ALIASES) if (aliases.some(a => t.includes(a))) { stageFilter = stage; break; }
    const r = await T('list_leads', stageFilter ? { stage: stageFilter, limit: 25 } : { limit: 25 });
    if (!r.ok) return done('List nahi mil saki: ' + r.summary);
    if (!r.data.count) return done(stageFilter ? `*${SL[stageFilter]}* stage me abhi koi lead nahi.` : 'Abhi koi lead nahi hai. *new lead add karo…* se pehli lead banayen.');
    return done(`*${stageFilter ? SL[stageFilter] + ' walay leads' : 'Saari leads'} (${r.data.count}):*\n` + r.data.leads.map(leadLine).join('\n'));
  }

  /* ---------- 9) platforms / knowledge ---------- */
  if (/(platforms? dikhao|platforms? batao|platform list|platforms? k[ai] naam)/i.test(t)) {
    const r = await T('search_platforms', {});
    return done('*GV ke platforms:*\n' + r.data.platforms.map((p, i) => `${i + 1}. ${p.name}${p.type ? ' — ' + p.type : ''}${p.followers ? ' (' + p.followers + ')' : ''}`).join('\n'));
  }
  if (/((package|knowledge|business).*(tafseel|detail|batao|dikhao))|price batao|package price/i.test(t)) {
    const r = await T('get_business_knowledge', {});
    const k = r.data;
    return done(`*${k.businessName} — ${k.package.name}*\n• Price: *${money(k.package.price)}*\n• Shamil: ${k.package.inclusions.join('; ')}\n• Delivery: ${k.package.deliveryDays}\n• Payment: ${k.paymentInstructions.split('\n')[0]}\n• Platforms: ${k.platforms.map(p => p.name.replace(/ —.*$/, '')).join(', ')}`);
  }

  /* ---------- 10) lead-targeted intents ---------- */
  const intent = matchLeadIntent(text, t);
  if (intent) {
    // followup intent baghair lead ke bhi ho sakta hai (general)
    if (intent.kind === 'followup' && !intent.query) {
      const r = await T('add_followup_task', { title: intent.extra.title, note: intent.extra.note || '', dueAt: intent.extra.dueAt || undefined });
      return done(r.ok ? 'Follow-up lag gaya — verified:\n' + r.summary : 'Follow-up nahi laga: ' + r.summary);
    }
    const r = await T('get_lead_detail', { query: intent.query });
    if (!r.ok) {
      if (r.error === 'AMBIGUOUS' && r.matches) {
        mem.pendingPick = { matches: r.matches.map(m => m.id), intent: { kind: intent.kind, extra: intent.extra || {} } };
        return done(`"${intent.query}" se ${r.matches.length} leads milein — konsi wali? Number likh dein:\n` + r.matches.map((m, i) => `${i + 1}. ${leadLine(m)}`).join('\n'), true);
      }
      return done(`"${intent.query}" ke naam se koi lead nahi mili. Naam check karein, ya *leads dikhao* se list dekh lein.`);
    }
    const txt = await runLeadIntent(ctx, mem, T, intent.kind, r.data.id, intent.extra || {});
    return done(txt, !!mem.pendingAction);
  }

  /* ---------- 11) fallback ---------- */
  return done('Ye command samajh nahi ayi. *madad* likhein to main saari commands examples ke saath bata dunga. Misal: "aaj ki report do" ya "new lead add karo: Ahmed, 0300…, Ahmed Shoes, Lahore, Fashion".');
}

function matchLeadIntent(text, t) {
  let m;
  if ((m = text.match(/(.+?)\s+par follow[-\s]?up lagao[:\s]+(.+)/i)) || (m = text.match(/(.+?)\s+ka follow[-\s]?up (?:add karo|lagao)[:\s]+(.+)/i))) {
    return { kind: 'followup', query: m[1].trim(), extra: { title: m[2].trim() } };
  }
  if ((m = text.match(/follow[-\s]?up (?:add karo|lagao)[:\s]+(.+)/i))) {
    return { kind: 'followup', query: null, extra: { title: m[1].trim() } };
  }
  if ((m = text.match(/(.+?)\s+ko whatsapp (?:par )?(?:message|msg) bhejo[:\s]+(.+)/is))) {
    return { kind: 'whatsapp', query: m[1].trim(), extra: { text: m[2].trim() } };
  }
  if ((m = text.match(/(.+?)\s+ki payment confirm karo(?:\s+(raast|jazzcash|easypaisa|bank|cash))?(?:\s+(\S+))?/i))) {
    const methods = { raast: 'Raast', jazzcash: 'JazzCash', easypaisa: 'EasyPaisa', bank: 'Bank', cash: 'Cash' };
    return { kind: 'payment', query: m[1].trim(), extra: { method: m[2] ? methods[m[2].toLowerCase()] : 'Raast', reference: m[3] || '' } };
  }
  if ((m = text.match(/(.+?)\s+k[ai]\s+material\s+(?:complete|pura|set)\s*(?:kar do|kardo|kar dein)?/i)) || (m = text.match(/(.+?)\s+k[ai]\s+material\s*:\s*(.+)/i))) {
    return { kind: 'material', query: m[1].trim(), extra: { itemsText: (m[2] || '').toLowerCase() } };
  }
  if ((m = text.match(/(.+?)\s+k[ai]\s+content banao/i)) || (m = text.match(/content banao\s+(?:for\s+)?(.+)/i))) {
    return { kind: 'content', query: m[1].trim() };
  }
  if ((m = text.match(/(.+?)\s+ko approve karo/i)) || (m = text.match(/(.+?)\s+ko publish queue me dalo/i))) {
    return { kind: 'approve', query: m[1].trim() };
  }
  if ((m = text.match(/(.+?)\s+ki report bhejo/i)) || (m = text.match(/report bhejo\s+(.+)/i))) {
    return { kind: 'report', query: m[1].trim() };
  }
  if ((m = text.match(/(.+?)\s+k[ai]\s+(.+?)\s+published\s*(?:mark)?\s*(?:karo|kar do)?(?:\s+link[:\s]+(\S+))?$/i))) {
    return { kind: 'publish', query: m[1].trim(), extra: { platformName: m[2].trim(), link: m[3] || '' } };
  }
  if ((m = text.match(/(.+?)\s+ko\s+(payment awaited|material pending|content ready|new|talking|approved|published|reported)\s*(?:me|mein)?\s*(?:dalo|kar do|kardo|move karo)/i))) {
    return { kind: 'stage', query: m[1].trim(), extra: { stage: m[2].toLowerCase().replace(/\s+/g, '_') } };
  }
  if ((m = text.match(/(.+?)\s+k[ai]\s+status batao/i)) || (m = text.match(/status\s+(?:batao\s+)?(.+)/i))) {
    return { kind: 'status', query: m[1].trim() };
  }
  return null;
}

/* Lead milne ke baad ka asal kaam — hamesha tools se, verify summary ke saath. */
async function runLeadIntent(ctx, mem, T, kind, leadId, extra) {
  const det = await T('get_lead_detail', { leadId });
  if (!det.ok) return 'Lead ab nahi mili (shayad delete ho gayi).';
  const L = det.data;
  const name = `*${L.business || L.name}*`;
  switch (kind) {
    case 'status': {
      const mat = L.material.complete ? 'Complete' : 'Missing: ' + L.material.missing.join(', ');
      const pay = L.payment.confirmed ? `${money(L.payment.amount)} via ${L.payment.method} (Ref: ${L.payment.reference || '—'}, Invoice: ${L.payment.invoiceNo})` : 'Confirm nahi';
      const pub = L.publish.length ? L.publish.map(q => `• ${q.platform.replace(/ —.*$/, '')}: ${q.status}${q.link ? ' — ' + q.link : ''}`).join('\n') : '• Publish queue me nahi';
      return `${name} — status\n• ID: ${L.id}\n• Contact: ${L.name} · ${L.phone || '—'} · ${L.city || '—'} · ${L.category || '—'}\n• Stage: *${L.stageLabel}*\n• Payment: ${pay}\n• Material: ${mat}\n• Content: ${L.contentReady ? 'Bana hua hai' : 'Nahi bana'}\n• Client approval: ${L.clientApproved ? 'Ho gaya' : 'Nahi'}\n• Publish:\n${pub}`;
    }
    case 'payment': {
      if (L.payment.confirmed) return `${name} ki payment pehle se confirm hai (${L.payment.method}, Invoice: ${L.payment.invoiceNo}). Dobara confirm nahi kiya.`;
      const args = { leadId, method: extra.method || 'Raast', reference: extra.reference || '' };
      mem.pendingAction = { tool: 'confirm_payment', args, description: tools.describeAction('confirm_payment', { ...args, query: L.business }) };
      return `Confirm karein — main ye karne laga hoon:\n• Lead: ${name} (${L.city || '—'})\n• Payment ${money(ctx.knowledge.package.price)} via *${args.method}*${args.reference ? ' (Ref: ' + args.reference + ')' : ''} CONFIRM mark karna hai\n• Is ke baad invoice banega aur stage age barhegi.\n\nAge barhoon? *yes / confirm* likhein, ya *cancel*.`;
    }
    case 'material': {
      const itemsText = extra.itemsText || '';
      const all = /(complete|pura|set)/.test(itemsText) || !itemsText;
      const patch = all
        ? { logo: true, photos: true, bio: true, links: true }
        : {
            logo: /logo/.test(itemsText) || undefined, photos: /photo|tasveer/.test(itemsText) || undefined,
            bio: /bio|about|tafseel/.test(itemsText) || undefined, links: /link/.test(itemsText) || undefined
          };
      Object.keys(patch).forEach(k => { if (patch[k] === undefined) delete patch[k]; });
      const r = await T('set_material', { leadId, ...patch });
      if (!r.ok) return 'Material update nahi hua: ' + r.summary;
      return r.data.material.complete
        ? `${name} ka material COMPLETE ho gaya — verified. Ab "…ka content banao" bolein to captions + script + designs bana dunga.`
        : `${name} ka material update ho gaya. Abhi missing: ${r.data.material.missing.join(', ')}.`;
    }
    case 'content': {
      const r = await T('generate_content', { leadId });
      if (!r.ok) {
        if (r.error === 'MATERIAL_INCOMPLETE') {
          const fu = await T('add_followup_task', { leadId, title: `Material mangwayen: ${L.business}`, note: 'Missing: ' + (r.missing || []).join(', ') });
          return `${name} ka content abhi nahi ban sakta — ye material reh gaya hai:\n${(r.missing || []).map(x => '• ' + x).join('\n')}\n\nMain ne is ke liye follow-up task bana diya hai${fu.ok ? ' (' + fu.data.id + ')' : ''} taake team client se material mangwaye. Material milte hi "…ka content banao" dobara bolein.`;
        }
        return 'Content nahi bana: ' + r.summary;
      }
      return `Content ban gaya — verified:\n• Business: ${name}\n• Captions: ${r.data.captionsCount} platforms ke liye\n• Script: tayyar\n• Design cards: ${r.data.designsCount}\n• Naya stage: *${r.data.stageLabel}*\nAb client se approval lein, phir bolein: "${L.business} ko approve karo".`;
    }
    case 'approve': {
      if (!L.contentReady) return `${name} ka content abhi bana hi nahi — pehle "…ka content banao" bolein.`;
      const args = { leadId, clientApprovedConfirmed: true };
      mem.pendingAction = { tool: 'approve_and_queue_publish', args, description: tools.describeAction('approve_and_queue_publish', { ...args, query: L.business }) };
      return `Confirm karein — main ye karne laga hoon:\n• Lead: ${name} ko APPROVE karke publish queue me dalna hai (har platform 1 row, kal 10 AM scheduled)\n• Client approval staff ne WhatsApp par confirm kiya hua samjha jayega.\n\nAge barhoon? *yes / confirm* likhein, ya *cancel*.`;
    }
    case 'report': {
      const r = await T('generate_client_report', { leadId });
      return r.ok ? `Report generate ho gayi — verified:\n• Business: ${name}\n• Naya stage: *${r.data.stageLabel}*\n\nNeeche report text hai — copy karke client ko bhej dein:\n\n${r.data.reportText}` : 'Report nahi bani: ' + r.summary;
    }
    case 'stage': {
      const r = await T('update_lead_stage', { leadId, stage: extra.stage });
      return r.ok ? `Stage badal gaya — verified: ${name} ab *${r.data.stageLabel}* stage me hai.` : 'Stage nahi badla: ' + r.summary;
    }
    case 'publish': {
      const r = await T('update_publish_status', { leadId, platformName: extra.platformName, status: 'published', link: extra.link || undefined });
      return r.ok ? 'Publish status update — verified:\n' + r.summary : 'Publish update nahi hua: ' + r.summary;
    }
    case 'followup': {
      const r = await T('add_followup_task', { leadId, title: extra.title || 'Follow-up', note: extra.note || '' });
      return r.ok ? `Follow-up lag gaya — verified:\n${r.summary}` : 'Follow-up nahi laga: ' + r.summary;
    }
    case 'whatsapp': {
      const args = { leadId, text: extra.text };
      mem.pendingAction = { tool: 'send_whatsapp_message', args, description: tools.describeAction('send_whatsapp_message', { ...args, query: L.business }) };
      return `Confirm karein — main ye message ${name} ko WhatsApp (${L.phone || 'number nahi'}) par bhejne laga hoon:\n"${extra.text}"\n\nBhejun? *yes / confirm* likhein, ya *cancel*.`;
    }
  }
  return 'Command samajh nahi aya.';
}

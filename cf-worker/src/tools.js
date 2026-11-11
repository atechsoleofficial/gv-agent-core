'use strict';
/* TOOL REGISTRY — agent ke haath. Node lib/tools.js se faithful port.
   ctx = { S (KV store), db (= S.data), knowledge, env, staffId, channel }
   Sirf storage/env access badla hai: svc.* ab ctx.S lete hain, kn.saveKnowledge()
   → ctx.S.saveKnowledge(), wa.sendWhatsApp(ctx.S, ctx.env, ...). */
import { STAGES, STAGE_LABEL } from './store.js';
import * as svc from './services.js';
import * as wa from './whatsapp.js';
import { money } from './textutil.js';

const S = { type: 'STRING' }, N = { type: 'NUMBER' }, B = { type: 'BOOLEAN' };
function params(properties, required) {
  return { type: 'OBJECT', properties, required: required || [] };
}
export function leadSummary(l, d) {
  if (!l) return null;
  return {
    id: l.id, name: l.name, phone: l.phone, business: l.business, city: l.city,
    category: l.category, source: l.source, stage: l.stage,
    stageLabel: STAGE_LABEL[l.stage] || l.stage,
    payment: l.payment && l.payment.confirmed
      ? { confirmed: true, amount: l.payment.amount, method: l.payment.method, reference: l.payment.reference, invoiceNo: l.invoiceNo, at: l.payment.at }
      : { confirmed: false },
    material: { ...(l.material || {}), complete: svc.materialComplete(l), missing: svc.missingMaterial(l) },
    contentReady: !!l.content,
    clientApproved: !!l.clientApproved,
    publish: (d.publishQueue || []).filter(q => q.leadId === l.id)
      .map(q => ({ platform: q.platformName, status: q.status, link: q.link || '', scheduledAt: q.scheduledAt }))
  };
}
/* leadId ya query/name se resolve. Ambiguous par guess nahi — matches wapas. */
export function resolveLead(ctx, args) {
  const d = ctx.db;
  if (args.leadId) {
    const l = svc.getLead(ctx.S, args.leadId);
    return l ? { lead: l } : { error: 'NOT_FOUND', summary: `Lead ID "${args.leadId}" nahi mili.` };
  }
  const q = args.query || args.name || args.business || '';
  const matches = svc.findLeads(ctx.S, q);
  if (!matches.length) return { error: 'NOT_FOUND', summary: `"${q}" ke naam se koi lead nahi mili.` };
  if (matches.length > 1) {
    return {
      error: 'AMBIGUOUS',
      matches: matches.map(m => leadSummary(m, d)),
      summary: `"${q}" se ${matches.length} leads milein — pehle staff se pooch kar confirm karein konsi wali.`
    };
  }
  return { lead: matches[0] };
}
function needLead(ctx, args) {
  const r = resolveLead(ctx, args);
  if (r.error) return { result: { ok: false, error: r.error, matches: r.matches, summary: r.summary } };
  return { lead: r.lead };
}

export const TOOLS = [
  {
    name: 'get_daily_report', sensitive: false,
    description: 'Aaj ki funnel report: stage counts, kul leads, aaj ki nayi leads, revenue (paid features), published posts, pending tasks aur open follow-ups.',
    parameters: params({}),
    async handler(ctx) {
      const dash = svc.dashboardData(ctx.S);
      return { ok: true, summary: `Report: ${dash.totalLeads} leads, revenue ${money(dash.revenue)} (${dash.paidCount} paid), ${dash.publishedCount} published, ${dash.tasks.length} pending tasks`, data: dash };
    }
  },
  {
    name: 'list_leads', sensitive: false,
    description: 'Leads ki list. stage (enum) ya search text se filter kar sakte hain.',
    parameters: params({ stage: S, search: S, limit: N }),
    async handler(ctx, args) {
      let leads = ctx.db.leads;
      if (args.stage) leads = leads.filter(l => l.stage === args.stage);
      if (args.search) {
        const q = String(args.search).toLowerCase();
        leads = leads.filter(l => (l.business + ' ' + l.name + ' ' + l.phone + ' ' + l.city).toLowerCase().includes(q));
      }
      const out = leads.slice(0, Number(args.limit) || 25).map(l => leadSummary(l, ctx.db));
      return { ok: true, summary: `${out.length} leads milein${args.stage ? ' (stage: ' + args.stage + ')' : ''}`, data: { count: out.length, leads: out } };
    }
  },
  {
    name: 'get_lead_detail', sensitive: false,
    description: 'Aik lead ki poori tafseel (leadId ya query/name se). Naam se zyada match hon to AMBIGUOUS error + matches milte hain.',
    parameters: params({ leadId: S, query: S }, []),
    async handler(ctx, args) {
      const { lead, result } = needLead(ctx, args);
      if (result) return result;
      return { ok: true, summary: `${lead.business || lead.name} — stage ${STAGE_LABEL[lead.stage]}`, data: leadSummary(lead, ctx.db) };
    }
  },
  {
    name: 'create_lead', sensitive: false,
    description: 'Nayi lead banata hai. name, phone, business lazmi hain; city/category ho to behtar.',
    parameters: params({ name: S, phone: S, business: S, city: S, category: S, source: S, notes: S }, ['name', 'phone', 'business']),
    async handler(ctx, args) {
      const lead = svc.createLead(ctx.S, { ...args, source: args.source || 'manual' });
      return { ok: true, summary: `Nayi lead ban gayi: ${lead.business} (${lead.name}, ${lead.city || '—'}) — ID ${lead.id}`, data: leadSummary(lead, ctx.db) };
    }
  },
  {
    name: 'update_lead_stage', sensitive: false,
    description: 'Lead ka stage badalta hai. stage in me se aik: ' + STAGES.join(', '),
    parameters: params({ leadId: S, query: S, stage: S }, ['stage']),
    async handler(ctx, args) {
      const { lead, result } = needLead(ctx, args);
      if (result) return result;
      const from = lead.stage;
      svc.setStage(ctx.S, lead, args.stage);
      return { ok: true, summary: `${lead.business} ka stage ${STAGE_LABEL[from]} → ${STAGE_LABEL[lead.stage]} ho gaya`, data: leadSummary(lead, ctx.db) };
    }
  },
  {
    name: 'confirm_payment', sensitive: true,
    description: 'Lead ki payment CONFIRM karta hai (method: Raast/JazzCash/EasyPaisa/Bank/Cash, reference, amount) aur invoice number issue karta hai. YE SENSITIVE HAI — pehle staff se explicit confirmation lazmi.',
    parameters: params({ leadId: S, query: S, method: S, reference: S, amount: N }, ['method']),
    async handler(ctx, args) {
      const { lead, result } = needLead(ctx, args);
      if (result) return result;
      if (lead.payment && lead.payment.confirmed) {
        return { ok: false, error: 'ALREADY_PAID', summary: `${lead.business} ki payment pehle se confirm hai (${lead.payment.method}, Invoice ${lead.invoiceNo}). Dobara confirm nahi kiya.`, data: leadSummary(lead, ctx.db) };
      }
      const methods = { raast: 'Raast', jazzcash: 'JazzCash', easypaisa: 'EasyPaisa', bank: 'Bank', cash: 'Cash' };
      const method = methods[String(args.method || 'Raast').toLowerCase()] || 'Raast';
      svc.confirmPayment(ctx.S, ctx.knowledge, lead, { method, reference: args.reference || '', amount: args.amount, by: ctx.staffId || 'agent' });
      const dash = svc.dashboardData(ctx.S);
      return {
        ok: true,
        summary: `Payment confirm: ${lead.business} — ${money(lead.payment.amount)} via ${lead.payment.method} (Ref: ${lead.payment.reference || '—'}), Invoice ${lead.invoiceNo}, naya stage ${STAGE_LABEL[lead.stage]}; kul revenue ab ${money(dash.revenue)}`,
        data: { ...leadSummary(lead, ctx.db), revenueTotal: dash.revenue, paidCount: dash.paidCount }
      };
    }
  },
  {
    name: 'set_material', sensitive: false,
    description: 'Lead ka material checklist update karta hai (logo, photos, bio, links — true/false). Jo fields bhejen ge sirf wahi badlen ge.',
    parameters: params({ leadId: S, query: S, logo: B, photos: B, bio: B, links: B, notes: S }),
    async handler(ctx, args) {
      const { lead, result } = needLead(ctx, args);
      if (result) return result;
      const patch = {};
      ['logo', 'photos', 'bio', 'links', 'notes'].forEach(k => { if (args[k] !== undefined) patch[k] = args[k]; });
      const r = svc.setMaterial(ctx.S, lead, patch);
      return { ok: true, summary: `${lead.business} ka material ${r.complete ? 'COMPLETE ho gaya' : 'update ho gaya — abhi missing: ' + r.missing.join(', ')}`, data: leadSummary(lead, ctx.db) };
    }
  },
  {
    name: 'generate_content', sensitive: false,
    description: 'Lead ke liye content banata hai: 4 platforms ke captions + reel script + SVG design cards. Material complete hona lazmi hai, warna MATERIAL_INCOMPLETE error + missing list milegi.',
    parameters: params({ leadId: S, query: S }),
    async handler(ctx, args) {
      const { lead, result } = needLead(ctx, args);
      if (result) return result;
      try {
        await svc.generateContent(ctx.S, ctx.knowledge, lead, ctx.env);
      } catch (e) {
        if (e.code === 'MATERIAL_INCOMPLETE') {
          return { ok: false, error: 'MATERIAL_INCOMPLETE', missing: e.missing, summary: `${lead.business} ka content nahi bana — material missing: ${e.missing.join(', ')}`, data: leadSummary(lead, ctx.db) };
        }
        throw e;
      }
      return {
        ok: true,
        summary: `Content ban gaya: ${lead.business} — ${Object.keys(lead.content.captions).length} captions + script + ${Object.keys(lead.content.designs).length} design cards; stage ${STAGE_LABEL[lead.stage]} (verify: dobara parha, content maujood hai)`,
        data: { ...leadSummary(lead, ctx.db), captionsCount: Object.keys(lead.content.captions).length, designsCount: Object.keys(lead.content.designs).length }
      };
    }
  },
  {
    name: 'approve_and_queue_publish', sensitive: true,
    description: 'Lead ko approve karke har platform ki publish queue row banata hai. SENSITIVE — client approval staff ke paas WhatsApp par aya ho, tab hi staff confirm kare to chalega.',
    parameters: params({ leadId: S, query: S, clientApprovedConfirmed: B }),
    async handler(ctx, args) {
      const { lead, result } = needLead(ctx, args);
      if (result) return result;
      if (!lead.content) return { ok: false, error: 'NO_CONTENT', summary: `${lead.business} ka content abhi bana hi nahi — pehle generate_content chalain.`, data: leadSummary(lead, ctx.db) };
      const r = svc.approveLead(ctx.S, lead);
      return { ok: true, summary: `Approve ho gaya: ${lead.business} — stage Approved, publish queue me ${r.queueAdded} nayi rows (kal 10 AM scheduled)`, data: leadSummary(lead, ctx.db) };
    }
  },
  {
    name: 'update_publish_status', sensitive: false,
    description: 'Publish queue update: kisi lead ke kisi platform ko published mark karna + link lagana. queueId, ya leadId/query + platformName dein.',
    parameters: params({ queueId: S, leadId: S, query: S, platformName: S, status: S, link: S }),
    async handler(ctx, args) {
      const d = ctx.db;
      let item = null;
      if (args.queueId) item = d.publishQueue.find(q => q.id === args.queueId);
      if (!item) {
        const { lead, result } = needLead(ctx, args);
        if (result) return result;
        const mine = d.publishQueue.filter(q => q.leadId === lead.id);
        if (args.platformName) {
          const pn = String(args.platformName).toLowerCase();
          item = mine.find(q => q.platformName.toLowerCase().includes(pn) || pn.includes(q.platformName.replace(/ —.*$/, '').toLowerCase()));
        }
        if (!item) item = mine.find(q => q.status === 'pending');
        if (!item) return { ok: false, error: 'NO_QUEUE', summary: `${lead.business} ki publish queue me matching row nahi mili.`, data: leadSummary(lead, d) };
      }
      svc.updatePublish(ctx.S, item, { status: args.status, link: args.link });
      const lead = svc.getLead(ctx.S, item.leadId);
      return { ok: true, summary: `Publish update: ${item.platformName.replace(/ —.*$/, '')} (${item.businessName}) → ${item.status}${item.link ? ' — ' + item.link : ''}${lead ? '; lead stage ab ' + (STAGE_LABEL[lead.stage]) : ''}`, data: { queueItem: item, lead: leadSummary(lead, d) } };
    }
  },
  {
    name: 'generate_client_report', sensitive: false,
    description: 'Client ke liye report text generate karta hai aur lead ko Reported stage par le jata hai.',
    parameters: params({ leadId: S, query: S }),
    async handler(ctx, args) {
      const { lead, result } = needLead(ctx, args);
      if (result) return result;
      const r = svc.sendReport(ctx.S, ctx.knowledge, lead);
      return { ok: true, summary: `Report generate ho gayi: ${lead.business} — stage Reported`, data: { ...leadSummary(lead, ctx.db), reportText: r.reportText } };
    }
  },
  {
    name: 'add_followup_task', sensitive: false,
    description: 'Follow-up task banata hai (lead ke saath ya general). dueAt ISO date/time ho sakta hai.',
    parameters: params({ leadId: S, query: S, title: S, note: S, dueAt: S }, ['title']),
    async handler(ctx, args) {
      let lead = null;
      if (args.leadId || args.query) {
        const r = resolveLead(ctx, args);
        if (r.error === 'AMBIGUOUS' || r.error === 'NOT_FOUND') return { ok: false, error: r.error, matches: r.matches, summary: r.summary };
        lead = r.lead;
      }
      const f = svc.addFollowup(ctx.S, { leadId: lead ? lead.id : args.leadId || null, title: args.title, note: args.note || '', dueAt: args.dueAt || null });
      return { ok: true, summary: `Follow-up ban gaya: "${f.title}"${lead ? ' — ' + lead.business : ''}${f.dueAt ? ' (due: ' + f.dueAt + ')' : ''}`, data: f };
    }
  },
  {
    name: 'list_followups', sensitive: false,
    description: 'Follow-ups ki list (status: open/done se filter).',
    parameters: params({ status: S }),
    async handler(ctx, args) {
      const list = svc.listFollowups(ctx.S, args.status || undefined);
      return { ok: true, summary: `${list.length} follow-ups${args.status ? ' (' + args.status + ')' : ''}`, data: { count: list.length, followups: list } };
    }
  },
  {
    name: 'search_platforms', sensitive: false,
    description: 'GV ke 4 media platforms ki registry dekhna/search karna.',
    parameters: params({ query: S }),
    async handler(ctx, args) {
      let plats = ctx.db.platforms;
      if (args && args.query) {
        const q = String(args.query).toLowerCase();
        plats = plats.filter(p => (p.name + ' ' + (p.type || '')).toLowerCase().includes(q));
      }
      return { ok: true, summary: `${plats.length} platforms`, data: { platforms: plats } };
    }
  },
  {
    name: 'get_business_knowledge', sensitive: false,
    description: 'Growth Ventures ki business knowledge: package, price, inclusions, platforms, payment instructions, behaviour rules.',
    parameters: params({}),
    async handler(ctx) {
      const k = ctx.knowledge;
      return {
        ok: true,
        summary: `Knowledge: ${k.businessName} — ${k.package.name} ${money(k.package.price)}, ${k.platforms.length} platforms, payment instructions maujood`,
        data: k
      };
    }
  },
  {
    name: 'update_business_knowledge', sensitive: false,
    description: 'Business knowledge update karta hai. fields object me jo keys bhejen ge sirf wahi badlen gi (misal: packagePrice, paymentInstructions, agentName, businessName, packageInclusions, behaviourRules, packageName, deliveryDays).',
    parameters: params({ fields: { type: 'OBJECT' } }, ['fields']),
    async handler(ctx, args) {
      const k = ctx.knowledge;
      const f = args.fields || {};
      const changed = [];
      if (f.businessName) { k.businessName = String(f.businessName); changed.push('businessName'); }
      if (f.agentName) { k.agentName = String(f.agentName); changed.push('agentName'); }
      if (f.salesAgentName) { k.salesAgentName = String(f.salesAgentName); changed.push('salesAgentName'); }
      if (f.paymentInstructions) { k.paymentInstructions = String(f.paymentInstructions); changed.push('paymentInstructions'); }
      if (f.packageName) { k.package.name = String(f.packageName); changed.push('packageName'); }
      if (f.packagePrice !== undefined && !isNaN(Number(f.packagePrice))) { k.package.price = Number(f.packagePrice); changed.push('packagePrice'); }
      if (f.deliveryDays) { k.package.deliveryDays = String(f.deliveryDays); changed.push('deliveryDays'); }
      if (Array.isArray(f.packageInclusions)) { k.package.inclusions = f.packageInclusions.map(String); changed.push('packageInclusions'); }
      if (Array.isArray(f.behaviourRules)) { k.behaviourRules = f.behaviourRules.map(String); changed.push('behaviourRules'); }
      ctx.S.saveKnowledge();
      return { ok: true, summary: `Knowledge update ho gayi: ${changed.length ? changed.join(', ') : 'koi change nahi aya'}`, data: { changed, knowledge: k } };
    }
  },
  {
    name: 'send_whatsapp_message', sensitive: true,
    description: 'Kisi client/number ko WhatsApp message bhejta hai. SENSITIVE — staff ki explicit confirmation ke baghair kabhi nahi bhejna.',
    parameters: params({ leadId: S, query: S, to: S, text: S }, ['text']),
    async handler(ctx, args) {
      let to = args.to || '';
      if (!to && (args.leadId || args.query)) {
        const r = resolveLead(ctx, args);
        if (r.error) return { ok: false, error: r.error, matches: r.matches, summary: r.summary };
        to = r.lead.phone;
      }
      if (!to) return { ok: false, error: 'NO_NUMBER', summary: 'Message bhejne ke liye number nahi mila.' };
      const sent = await wa.sendWhatsApp(ctx.S, ctx.env, to, args.text);
      return { ok: sent.ok, summary: `WhatsApp message ${sent.ok ? 'bhej diya gaya' : 'NAHI gaya'} → ${to}${sent.simulated ? ' (simulated — outbox me hai, asal token set nahi)' : ''}`, data: { to, simulated: !!sent.simulated } };
    }
  }
];

export const byName = {};
TOOLS.forEach(t => { byName[t.name] = t; });

export async function runTool(ctx, name, args) {
  const tool = byName[name];
  if (!tool) return { ok: false, error: 'UNKNOWN_TOOL', summary: `Tool "${name}" maujood nahi.` };
  try {
    return await tool.handler(ctx, args || {});
  } catch (e) {
    console.error('tool error', name, e);
    return { ok: false, error: 'TOOL_ERROR', summary: `Tool ${name} me error: ${e.message}` };
  }
}

export function geminiDeclarations() {
  return TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
export function isSensitive(name) { const t = byName[name]; return !!(t && t.sensitive); }
export function describeAction(name, args) {
  const a = args || {};
  switch (name) {
    case 'confirm_payment': return `Payment CONFIRM karna — lead: ${a.query || a.leadId || '?'}, method: ${a.method || 'Raast'}${a.reference ? ', ref: ' + a.reference : ''}, amount: ${a.amount ? money(a.amount) : 'package price'}`;
    case 'approve_and_queue_publish': return `Lead ko APPROVE karke publish queue me dalna — lead: ${a.query || a.leadId || '?'}`;
    case 'send_whatsapp_message': return `WhatsApp message bhejna — to: ${a.to || a.query || a.leadId || '?'}, text: "${String(a.text || '').slice(0, 120)}"`;
    default: return `${name} chalana`;
  }
}

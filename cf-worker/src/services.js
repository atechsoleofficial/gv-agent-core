'use strict';
/* Shared service layer — pipeline / payment / material / content / publish / report / follow-ups.
   Node lib/services.js se port: pehla argument ab raw db ki jagah KV store adapter (S) hai,
   aur store.save() → S.save(). Logic bilkul wahi hai. */
import { STAGES, uid, nowISO } from './store.js';
import * as content from './content.js';

export function touch(lead) { lead.updatedAt = nowISO(); }

export function materialComplete(lead) {
  const m = (lead && lead.material) || {};
  return !!(m.logo && m.photos && m.bio && m.links);
}
export function missingMaterial(lead) {
  const m = (lead && lead.material) || {};
  const labels = { logo: 'Logo', photos: 'Photos', bio: 'Bio / About', links: 'Social links' };
  return Object.keys(labels).filter(k => !m[k]).map(k => labels[k]);
}

export function createLead(S, data) {
  const d = S.data;
  const lead = {
    id: uid('lead'),
    name: (data.name || '').trim(),
    phone: (data.phone || '').trim(),
    business: (data.business || '').trim(),
    city: (data.city || '').trim(),
    category: (data.category || '').trim(),
    source: ['ad', 'organic', 'referral', 'manual', 'agent', 'whatsapp'].includes(data.source) ? data.source : 'manual',
    stage: STAGES.includes(data.stage) ? data.stage : 'new',
    notes: data.notes || '',
    material: { logo: false, photos: false, bio: false, links: false, notes: '' },
    payment: null,
    invoiceNo: null,
    content: null,
    clientApproved: false,
    conversation: [],
    reportText: '',
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  d.leads.push(lead);
  S.save();
  return lead;
}

export function getLead(S, id) { return S.data.leads.find(l => l.id === id); }

export function findLeads(S, query) {
  const d = S.data;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const exact = d.leads.filter(l => l.id.toLowerCase() === q);
  if (exact.length) return exact;
  return d.leads.filter(l =>
    (l.business || '').toLowerCase().includes(q) ||
    (l.name || '').toLowerCase().includes(q) ||
    (l.phone || '').toLowerCase().includes(q));
}

export function setStage(S, lead, stage) {
  if (!STAGES.includes(stage)) throw new Error('Galat stage: ' + stage);
  lead.stage = stage; touch(lead); S.save();
  return lead;
}

/* Payment — staff-confirmed only (kabhi screenshot par andha aitbaar nahi). */
export function confirmPayment(S, kn, lead, { method, reference, amount, by } = {}) {
  const d = S.data;
  const methods = ['Raast', 'JazzCash', 'EasyPaisa', 'Bank', 'Cash'];
  if (!lead.invoiceNo) { d.invoiceSeq += 1; lead.invoiceNo = 'GV-INV-' + d.invoiceSeq; }
  lead.payment = {
    confirmed: true,
    method: methods.includes(method) ? method : 'Raast',
    reference: reference || '',
    amount: Number(amount) || kn.package.price,
    at: nowISO(), by: by || 'staff'
  };
  if (['new', 'talking', 'payment_awaited', 'payment_confirmed'].includes(lead.stage)) {
    lead.stage = 'material_pending';
  }
  touch(lead); S.save();
  return lead;
}

export function setMaterial(S, lead, patch) {
  ['logo', 'photos', 'bio', 'links'].forEach(k => { if (patch[k] !== undefined) lead.material[k] = !!patch[k]; });
  if (patch.notes !== undefined) lead.material.notes = patch.notes;
  if (lead.payment && lead.payment.confirmed && !materialComplete(lead)) lead.stage = 'material_pending';
  touch(lead); S.save();
  return { lead, complete: materialComplete(lead), missing: missingMaterial(lead) };
}

export async function generateContent(S, kn, lead, env) {
  const d = S.data;
  if (!materialComplete(lead)) {
    const err = new Error('Material incomplete hai: ' + missingMaterial(lead).join(', '));
    err.code = 'MATERIAL_INCOMPLETE'; err.missing = missingMaterial(lead);
    throw err;
  }
  const settings = { packagePrice: kn.package.price };
  let captions = content.generateCaptions(lead, d.platforms, settings);
  const firstId = d.platforms[0] && d.platforms[0].id;
  if (firstId && captions[firstId]) captions[firstId] = await content.maybePolishWithGemini(captions[firstId], lead, env);
  const designs = {};
  d.platforms.forEach(p => { designs[p.id] = content.generateDesignSVG(lead, p); });
  lead.content = { captions, script: content.generateScript(lead), designs, generatedAt: nowISO() };
  lead.stage = 'content_ready';
  touch(lead); S.save();
  return lead;
}

export function approveLead(S, lead) {
  const d = S.data;
  lead.clientApproved = true;
  lead.stage = 'approved';
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  let added = 0;
  d.platforms.forEach(p => {
    if (!d.publishQueue.some(q => q.leadId === lead.id && q.platformId === p.id)) {
      d.publishQueue.push({
        id: uid('pub'), leadId: lead.id, platformId: p.id,
        platformName: p.name, businessName: lead.business || lead.name,
        scheduledAt: tomorrow.toISOString(), status: 'pending', link: ''
      });
      added++;
    }
  });
  touch(lead); S.save();
  return { lead, queueAdded: added };
}

export function updatePublish(S, item, patch) {
  const d = S.data;
  if (patch.scheduledAt !== undefined) item.scheduledAt = patch.scheduledAt;
  if (patch.link !== undefined) item.link = patch.link;
  if (patch.status !== undefined && ['pending', 'published'].includes(patch.status)) item.status = patch.status;
  const lead = getLead(S, item.leadId);
  if (lead) {
    const mine = d.publishQueue.filter(x => x.leadId === lead.id);
    if (mine.length && mine.every(x => x.status === 'published')) lead.stage = 'published';
    touch(lead);
  }
  S.save();
  return item;
}

export function sendReport(S, kn, lead) {
  const d = S.data;
  const rows = d.publishQueue.filter(q => q.leadId === lead.id);
  const lines = [
    `Assalam o Alaikum ${lead.name || ''}, aap ke ${kn.package.name} ki report tayyar hai.`,
    ``,
    `Business: ${lead.business}`,
    `Package: ${kn.package.name} — Rs ${Number(kn.package.price).toLocaleString('en-PK')}`,
    ``,
    `Aap ki feature post in platforms par publish ho gayi hai:`
  ];
  rows.forEach(q => lines.push(`• ${q.platformName.replace(/ —.*$/, '')}: ${q.link || '(link pending)'}`));
  lines.push('', 'Aap ke business ki reach aur enquiries par asar jald nazar ayega. Mazeed growth ke liye hamaray monthly packages par bhi ghaur karein. Shukriya — Team ' + kn.businessName);
  lead.reportText = lines.join('\n');
  lead.stage = 'reported';
  lead.reportedAt = nowISO();
  touch(lead); S.save();
  return { lead, reportText: lead.reportText };
}

export function dashboardData(S) {
  const d = S.data;
  const counts = {};
  STAGES.forEach(s => counts[s] = 0);
  d.leads.forEach(l => { if (counts[l.stage] !== undefined) counts[l.stage]++; });
  const revenue = d.leads.reduce((sum, l) => sum + (l.payment && l.payment.confirmed ? Number(l.payment.amount || 0) : 0), 0);
  const paidCount = d.leads.filter(l => l.payment && l.payment.confirmed).length;
  const publishedCount = d.publishQueue.filter(q => q.status === 'published').length;
  const today = new Date().toISOString().slice(0, 10);
  const tasks = [];
  d.leads.forEach(l => {
    if (l.stage === 'payment_awaited') tasks.push({ type: 'payment_followup', leadId: l.id, label: `Payment follow-up: ${l.business || l.name}` });
    if (l.stage === 'material_pending' && !materialComplete(l)) tasks.push({ type: 'material', leadId: l.id, label: `Material mangwayen: ${l.business || l.name} (missing: ${missingMaterial(l).join(', ')})` });
    if (l.stage === 'content_ready') tasks.push({ type: 'approval', leadId: l.id, label: `Client approval lein: ${l.business || l.name}` });
  });
  d.publishQueue.filter(q => q.status === 'pending' && q.scheduledAt && q.scheduledAt.slice(0, 10) <= today)
    .forEach(q => tasks.push({ type: 'publish', leadId: q.leadId, label: `Publish karein (${q.platformName}): ${q.businessName}` }));
  const recent = [...d.leads].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
  const newToday = d.leads.filter(l => (l.createdAt || '').slice(0, 10) === today).length;
  const openFollowups = (d.followups || []).filter(f => f.status === 'open').length;
  return { counts, totalLeads: d.leads.length, revenue, paidCount, publishedCount, recent, tasks, newToday, openFollowups };
}

/* ---------------- follow-ups ---------------- */
export function addFollowup(S, { leadId, title, note, dueAt } = {}) {
  const f = {
    id: uid('fu'),
    leadId: leadId || null,
    title: (title || '').trim() || 'Follow-up',
    note: note || '',
    dueAt: dueAt || null,
    status: 'open',
    createdAt: nowISO(),
    remindedAt: null,
    reminderTaskId: null
  };
  S.data.followups.push(f);
  S.save();
  return f;
}
export function listFollowups(S, status) {
  return (S.data.followups || []).filter(f => !status || f.status === status);
}
export function completeFollowup(S, id) {
  const f = (S.data.followups || []).find(x => x.id === id);
  if (!f) return null;
  f.status = 'done'; f.doneAt = nowISO();
  S.save();
  return f;
}

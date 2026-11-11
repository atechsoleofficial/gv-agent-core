'use strict';
/* Scheduler — Node lib/scheduler.js se port. setInterval timer ki jagah Cloudflare
   Cron Triggers (wrangler.toml [triggers]): daily cron 04:00 UTC (= 09:00 PKT) par
   dailyReport(), hourly cron par followupScan(). Dono functions wahi code paths
   (tools) istemal karte hain jo Node version karta tha. */
import { uid, nowISO } from './store.js';
import * as tools from './tools.js';
import * as wa from './whatsapp.js';
import { pktNow } from './textutil.js';

/* Node me DAILY_REPORT_TIME env tha (default 09:00 PKT). Workers me report ka waqt
   wrangler.toml ke cron (04:00 UTC) se fix hai — ye value sirf label/note ke liye hai. */
export function reportTimeLabel(env) { return env.DAILY_REPORT_TIME || '09:00'; }

function schedCtx(S, env) {
  return { S, db: S.data, knowledge: S.knowledge, env, staffId: 'system', channel: 'scheduler' };
}

export async function dailyReport(S, env, reason) {
  const db = S.data;
  const { dateStr } = pktNow();
  /* Node tick wala guard: aik din me aik hi auto report (cron double-fire se bachao). */
  if (db.schedulerState.lastDailyReportDate === dateStr) return null;
  db.schedulerState.lastDailyReportDate = dateStr;
  S.save();

  const ctx = schedCtx(S, env);
  const task = {
    id: uid('task'), staffId: 'system', channel: 'scheduler',
    input: 'Daily report (scheduled' + (reason ? ' — ' + reason : '') + ')',
    brain: 'scheduler', plan: [], toolCalls: [], status: 'running',
    finalSummary: '', createdAt: nowISO(), finishedAt: null
  };
  db.tasks.push(task);
  const r = await tools.runTool(ctx, 'get_daily_report', {});
  task.toolCalls.push({ tool: 'get_daily_report', args: {}, ok: !!r.ok, summary: r.summary, at: nowISO() });
  const dash = r.data || {};
  const lines = [
    `*Daily Report — ${new Date().toLocaleDateString('en-PK')} (Growth Ventures Feature Funnel)*`,
    `Kul leads: ${dash.totalLeads} · Aaj nayi: ${dash.newToday}`,
    `Revenue: Rs ${Number(dash.revenue || 0).toLocaleString('en-PK')} (${dash.paidCount} paid)`,
    `Published: ${dash.publishedCount} · Pending tasks: ${(dash.tasks || []).length} · Open follow-ups: ${dash.openFollowups || 0}`
  ];
  (dash.tasks || []).slice(0, 6).forEach(t => lines.push('• ' + t.label));
  task.finalSummary = lines.join('\n');
  task.plan = task.toolCalls.map(s => `${s.tool}: ${s.summary}`);
  task.status = 'done';
  task.finishedAt = nowISO();
  await S.persist();

  const owner = env.OWNER_NUMBER;
  if (owner) { await wa.sendWhatsApp(S, env, owner, task.finalSummary); await S.persist(); }
  return task;
}

export async function followupScan(S, env) {
  const db = S.data;
  const now = Date.now();
  const due = (db.followups || []).filter(f =>
    f.status === 'open' && !f.reminderTaskId && f.dueAt && new Date(f.dueAt).getTime() <= now);
  const made = [];
  for (const f of due) {
    const task = {
      id: uid('task'), staffId: 'system', channel: 'scheduler',
      input: 'Follow-up reminder: ' + f.title,
      brain: 'scheduler', plan: [], toolCalls: [], status: 'done',
      finalSummary: `Follow-up DUE hai: "${f.title}"${f.leadId ? ' (lead: ' + f.leadId + ')' : ''}${f.note ? ' — ' + f.note : ''}. Team is par action le.`,
      createdAt: nowISO(), finishedAt: nowISO()
    };
    db.tasks.push(task);
    f.reminderTaskId = task.id;
    f.remindedAt = nowISO();
    made.push(task);
  }
  if (made.length) {
    await S.persist();
    const owner = env.OWNER_NUMBER;
    if (owner) {
      for (const t of made) await wa.sendWhatsApp(S, env, owner, t.finalSummary);
      await S.persist();
    }
  }
  return made;
}

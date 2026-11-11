'use strict';
/* AGENT BRAIN — Muse style loop. Node lib/agent.js se faithful port.
   Command aata hai → TASK record banta hai → brain tools chala kar kaam karta hai →
   har tool call task log me trace hota hai → final verified summary.
   Brain do tarah ka hai:
   - GEMINI_API_KEY (env/secret) ho to Gemini function calling loop.
   - Warna deterministic fallback planner (src/fallback.js) — wahi tools, offline testable.
   Storage: store singleton ki jagah ctx.S (KV adapter); env process.env ki jagah env bindings.
   Dono me sensitive tools (payment / approve / whatsapp send) brain-level gate se
   guzarte hain: pehle pendingAction + staff se "yes", phir execution. */
import { uid, nowISO } from './store.js';
import * as tools from './tools.js';
import * as fallback from './fallback.js';
import { isYes, isNo, stripYesPrefix } from './textutil.js';

function maxRounds(env) { return Math.max(1, Number(env.AGENT_MAX_TOOL_ROUNDS) || 8); }
function model(env) { return env.GEMINI_MODEL || 'gemini-2.5-flash'; }

export function brainMode(env) { return env.GEMINI_API_KEY ? 'gemini' : 'fallback'; }

export function getMemory(S, staffId) {
  const db = S.data;
  if (!db.staffMemory[staffId]) {
    db.staffMemory[staffId] = { history: [], pendingAction: null, pendingPick: null, pendingCommand: null, collecting: null };
  }
  return db.staffMemory[staffId];
}

function clipArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = (typeof v === 'string' && v.length > 90) ? v.slice(0, 90) + '…' : v;
  }
  return out;
}

export function systemPrompt(knowledge) {
  const k = knowledge;
  return [
    `Tum ${k.agentName} ho — ${k.businessName} (${k.businessTagline}) ke operations agent.`,
    `Tum Muse ki tarah kaam karte ho: staff natural language me command deta hai, tum plan bana kar TOOLS se asal kaam karte ho, phir state dobara parh kar verify karke concrete numbers ke saath summary dete ho.`,
    ``,
    `BUSINESS KNOWLEDGE:`,
    `- Package: ${k.package.name} — Rs ${Number(k.package.price).toLocaleString('en-PK')}. Shamil: ${k.package.inclusions.join('; ')}. Delivery: ${k.package.deliveryDays}.`,
    `- Platforms (${k.platforms.length}): ${k.platforms.map(p => p.name).join(', ')}.`,
    `- Payment instructions: ${k.paymentInstructions.replace(/\n/g, ' | ')}`,
    `- Note: ${k.paymentNote}`,
    ``,
    `RULES (lazmi):`,
    ...k.behaviourRules.map(r => `- ${r}`),
    `- Har data sirf tools se lo — kabhi lead, payment, stage ya number invent mat karo.`,
    `- Multi-step kaam aik hi command me pura karo (misal: content banane se pehle get_lead_detail se material check karo; material missing ho to add_followup_task bhi lagao).`,
    `- Tool AMBIGUOUS error de to matches ki list staff ko dikha kar poocho, guess mat karo.`,
    `- confirm_payment, approve_and_queue_publish aur send_whatsapp_message SENSITIVE hain: jab tum inhe call karo ge to system khud staff se confirmation mangega aur tab tak execute nahi hoga — is liye sahi waqt par bila-jhijhak call karo, lekin text me jhooti "ho gaya" kabhi mat likho jab tak tool result na aye.`,
    `- Jawab Roman Urdu/English mix me, mukhtasir, numbers ke saath. Sirf final summary do — tool results ko Urdu me samjha kar.`,
    `- Agar command samajh na aye to madad wali commands ki misalein do.`
  ].join('\n');
}

/* ---------------- Gemini function-calling loop ---------------- */
async function geminiCall(env, contents, knowledge) {
  const key = env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model(env)}:generateContent?key=` + encodeURIComponent(key);
  const body = {
    system_instruction: { parts: [{ text: systemPrompt(knowledge) }] },
    contents,
    tools: [{ function_declarations: tools.geminiDeclarations() }]
  };
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Gemini HTTP ' + r.status + ' ' + txt.slice(0, 160));
  }
  return r.json();
}

async function runGemini(ctx, task, text) {
  const mem = ctx.memory;
  const steps = task.toolCalls;
  const T = async (name, args) => {
    const r = await tools.runTool(ctx, name, args || {});
    steps.push({ tool: name, args: clipArgs(args), ok: !!r.ok, error: r.error || undefined, summary: r.summary || '', at: new Date().toISOString() });
    return r;
  };

  /* pending sensitive action ka gate — Gemini mode me bhi wahi rule */
  if (mem.pendingAction) {
    const action = mem.pendingAction;
    if (isYes(text)) {
      mem.pendingAction = null;
      const r = await T(action.tool, action.args);
      let out = r.ok ? `Ho gaya — verified:\n${r.summary}` : `Action nahi ho saka: ${r.summary}`;
      if (r.ok && action.args && action.args.leadId) {
        const v = await T('get_lead_detail', { leadId: action.args.leadId });
        if (v.ok) out += `\nDobara parh kar verify kiya — stage ab: *${v.data.stageLabel}*.`;
      }
      const rest = stripYesPrefix(text);
      if (rest && rest.length > 3) {
        const more = await geminiLoop(ctx, task, rest, T);
        return { finalText: out + '\n\n' + more.finalText, awaiting: more.awaiting };
      }
      return { finalText: out, awaiting: false };
    }
    if (isNo(text)) { mem.pendingAction = null; return { finalText: 'Theek hai, pending action cancel kar diya.', awaiting: false }; }
    return { finalText: `Aik action aap ki confirmation ka wait kar raha hai:\n${action.description}\n\nAge barhne ke liye *yes / confirm* likhein, ya *cancel*.`, awaiting: true };
  }
  return geminiLoop(ctx, task, text, T);
}

async function geminiLoop(ctx, task, text, T) {
  const mem = ctx.memory;
  const MAX_ROUNDS = maxRounds(ctx.env);
  const contents = [];
  (mem.history || []).slice(-12).forEach(h => {
    contents.push({ role: h.from === 'staff' ? 'user' : 'model', parts: [{ text: h.text }] });
  });
  contents.push({ role: 'user', parts: [{ text }] });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let resp;
    try {
      resp = await geminiCall(ctx.env, contents, ctx.knowledge);
    } catch (e) {
      if (task.toolCalls.length === 0) return { geminiFailed: e.message };
      return { finalText: `Gemini beech me ruk gaya (${e.message}). Jo steps ho chuke hain un ki tafseel task log me hai — dobara command de kar age barha sakte hain.`, awaiting: false };
    }
    const cand = resp && resp.candidates && resp.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const calls = parts.filter(p => p.functionCall);
    const textPart = parts.filter(p => p.text).map(p => p.text).join('\n').trim();

    if (!calls.length) {
      return { finalText: textPart || 'Ho gaya.', awaiting: false };
    }
    contents.push({ role: 'model', parts });

    /* Sensitive tool? Pehle gate — execute nahi karna. */
    const sensitive = calls.find(c => tools.isSensitive(c.functionCall.name));
    if (sensitive) {
      const name = sensitive.functionCall.name;
      const args = sensitive.functionCall.args || {};
      mem.pendingAction = { tool: name, args, description: tools.describeAction(name, args) };
      return {
        finalText: `Confirm karein — main ye karne laga hoon:\n${mem.pendingAction.description}\n\nAge barhoon? *yes / confirm* likhein, ya *cancel*.`,
        awaiting: true
      };
    }

    const responseParts = [];
    for (const c of calls) {
      const name = c.functionCall.name;
      const args = c.functionCall.args || {};
      const r = await T(name, args);
      const resultForModel = { ok: r.ok, summary: r.summary, error: r.error, data: r.data, missing: r.missing, matches: r.matches };
      responseParts.push({ functionResponse: { name, response: { result: resultForModel } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  return { finalText: `Tool rounds ki limit (${MAX_ROUNDS}) khatam ho gayi. Jo steps huay wo task log me hain — command ko chhota karke dobara dein.`, awaiting: false };
}

/* ---------------- public entry: har command = aik task ---------------- */
export async function runCommand({ S, env, staffId, channel, text }) {
  const db = S.data;
  const knowledge = S.knowledge;
  const memory = getMemory(S, staffId);
  const ctx = { S, db, knowledge, env, staffId, channel: channel || 'web', memory };
  const task = {
    id: uid('task'),
    staffId, channel: channel || 'web',
    input: String(text || ''),
    brain: brainMode(env),
    plan: [], toolCalls: [],
    status: 'running', finalSummary: '',
    createdAt: nowISO(), finishedAt: null
  };
  db.tasks.push(task);
  S.save();

  try {
    let out;
    if (brainMode(env) === 'gemini') {
      out = await runGemini(ctx, task, text);
      if (out.geminiFailed) {
        task.brain = 'fallback (gemini error: ' + String(out.geminiFailed).slice(0, 120) + ')';
        out = await fallback.execute(ctx, memory, text, task.toolCalls);
      }
    } else {
      out = await fallback.execute(ctx, memory, text, task.toolCalls);
    }
    task.finalSummary = out.finalText;
    task.status = out.awaiting ? 'awaiting_confirmation' : 'done';
  } catch (e) {
    console.error('agent runCommand error', e);
    task.status = 'error';
    task.finalSummary = 'Agent me error aya: ' + e.message;
  }
  task.plan = task.toolCalls.map(s => `${s.tool}: ${s.summary || (s.ok ? 'ok' : 'failed')}`);
  task.finishedAt = nowISO();

  memory.history.push({ from: 'staff', text: String(text || ''), at: nowISO() });
  memory.history.push({ from: 'agent', text: task.finalSummary, at: nowISO() });
  if (memory.history.length > 60) memory.history = memory.history.slice(-60);
  await S.persist();

  return { task, reply: task.finalSummary, steps: task.toolCalls, status: task.status, brain: task.brain };
}

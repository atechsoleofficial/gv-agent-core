'use strict';
/* WhatsApp Chat Agent — rule/state based sales agent (Roman Urdu/English mix).
   Node lib/salesAgent.js se faithful port — sirf Gemini key env binding se aati hai
   (geminiSmallTalk ko ctx.env milta hai). Flow aur tamam texts wahi hain. */

export function isYes(t) {
  return /\b(yes|ha+|han|ji|ok|okay|theek|bilkul|zaroor|interested|karwana hai|krwana|chahiye|done|confirm)\b/i.test(t)
    || /^(ha|han|ji|g|yes)/i.test(t.trim());
}
export function isNo(t) { return /\b(no|nahi|nhi|not interested|rehne do)\b/i.test(t); }

export function packagePitch(settings) {
  const plats = settings._platformNames || 'hamaray 4 platforms';
  return `Bohat khoob! Hamara *Feature Package* sirf *Rs ${Number(settings.packagePrice).toLocaleString('en-PK')}* me hai, jis me shamil hai:\n` +
    `✅ Aapke business ki professional design post\n✅ Content / caption writing (Urdu + English)\n✅ Short script (reel / voiceover ke liye)\n✅ Publishing — ${plats} — chaaron platforms par\n✅ Post links + report\n\n` +
    `Aksar clients ko feature ke baad enquiries barh jati hain, kyunke log naye business ko pehle social proof dekh kar hi trust karte hain.`;
}

export function paymentInstructions(settings, lead) {
  return `Zabardast, ${lead.business} ka Feature Package confirm ho gaya hai! 🎉\n\n` +
    `Payment ke liye Rs ${Number(settings.packagePrice).toLocaleString('en-PK')} is account par bhej dein:\n${settings.paymentDetails}\n\n` +
    `Payment ke baad screenshot isi chat me bhej dein — hamari team confirm karke aap ko material list bhej degi (logo, photos, business ki tafseel). Phir design aur content bana kar approval ke liye aap ko bheja jayega, approval ke baad chaaron platforms par publish ho jayega.`;
}

export function faqAnswer(t, settings) {
  const s = settings;
  if (/(price|rate|qeemat|kimat|cost|charges|fees|kitne|kitna paisa)/i.test(t)) {
    return `Feature Package ki price *Rs ${Number(s.packagePrice).toLocaleString('en-PK')}* hai — is me design, content, script aur chaaron platforms par publishing sab shamil hai. Koi hidden charges nahi.`;
  }
  if (/(kia (milega|shamil|include)|include|package me|detail|features|kia kia)/i.test(t)) {
    return packagePitch(s);
  }
  if (/(kitne din|time|kab tak|duration|process|kaise hoga|kesay)/i.test(t)) {
    return `Process simple hai: (1) payment confirm, (2) aap material bhejte hain (logo, photos, tafseel), (3) hum design + content bana kar approval ke liye bhejte hain, (4) approval ke baad chaaron platforms par publish karke links + report bhej dete hain. Aam tor par 2-3 working days lagte hain.`;
  }
  if (/(platform|kahan publish|kis kis|startup pakistan)/i.test(t)) {
    return `Aap ki post hamaray 4 platforms par publish hogi: ${s._platformNames || 'Startup Pakistan aur 3 aur platforms'}. Is se aap ke business ko mukhtalif audiences tak reach milti hai.`;
  }
  if (/(payment|pay|jazzcash|easypaisa|raast|bank)/i.test(t)) {
    return `Payment aap Raast, JazzCash, EasyPaisa ya bank transfer se kar sakte hain. Jab aap package confirm kar dein ge to main aap ko isi chat me account details bhej dunga. Payment ki tasdeeq hamari team karegi, phir kaam shuru ho jayega.`;
  }
  if (/(discount|kam kar|mehenga|zyada)/i.test(t)) {
    return `Samajh sakta hoon, lekin is package me 4 platforms ki publishing, design aur content sab mila kar ye bohat hi reasonable deal hai — aik platform ki bhi aksar is se zyada charge hota hai. Quality par compromise nahi karte hum. Aap chahein to pehle sample features ke links dekh lein?`;
  }
  return null;
}

async function geminiSmallTalk(history, settings, env) {
  const key = env && env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
    const prompt = `You are ${settings.agentName} of ${settings.businessName}, a friendly Pakistani sales agent on WhatsApp selling a "Feature Package" (Rs ${settings.packagePrice}) that features a client's business on 4 media platforms including Startup Pakistan, with design, content, script and publishing included. Reply in Roman Urdu/English mix, max 60 words, warm sales tone. Conversation so far:\n` +
      history.slice(-6).map(m => `${m.from === 'agent' ? 'Agent' : 'Client'}: ${m.text}`).join('\n') +
      `\nAgent:`;
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
    return out ? out.trim() : null;
  } catch (e) { return null; }
}

/**
 * Handle one incoming message.
 * ctx: { S, env, settings (with _platformNames), session, text, upsertLeadFromSession(sess) }
 * Returns { replies: [..], session } — caller persists session + lead changes.
 */
export async function handleMessage(ctx) {
  const { settings, session, text } = ctx;
  const t = (text || '').trim();
  const replies = [];
  if (!session.step) session.step = 'start';
  if (!session.data) session.data = {};
  if (!session.history) session.history = [];
  session.history.push({ from: 'lead', text: t, at: new Date().toISOString() });

  // First contact
  if (session.step === 'start') {
    session.step = 'ask_business';
    replies.push(`Assalam o Alaikum! 👋 Main ${settings.agentName}, ${settings.businessName} se. Hum businesses ko apnay 4 media platforms par feature karte hain taake un ko zyada customers aur pehchan mile.\n\nPehle ye batayen — aap ke business ka naam kya hai?`);
    return done(ctx, replies);
  }

  // FAQ can interrupt qualification at any point
  const faq = faqAnswer(t, settings);
  if (faq && !['confirm', 'done'].includes(session.step)) {
    replies.push(faq);
    // nudge back to the current qualification question
    if (session.step === 'ask_business') replies.push('Waisay, aap ke business ka naam kya hai? Us se aage barhte hain.');
    else if (session.step === 'ask_city') replies.push(`Acha, aur ${session.data.business} kis sheher me hai?`);
    else if (session.step === 'ask_category') replies.push(`${session.data.business} kis category ka business hai? (misal: food, fashion, salon, electronics, services waghera)`);
    else if (session.step === 'pitch') replies.push('Agar aap tayyar hain to bas "confirm" likh dein — main aap ki booking bana kar payment details bhej dunga. 🙂');
    return done(ctx, replies);
  }

  switch (session.step) {
    case 'ask_business': {
      session.data.business = t.slice(0, 80);
      session.step = 'ask_city';
      replies.push(`Bohat acha, *${session.data.business}* — naam se hi lagta hai quality kaam hoga. Ye kis sheher me hai?`);
      break;
    }
    case 'ask_city': {
      session.data.city = t.slice(0, 40);
      session.step = 'ask_category';
      replies.push(`${session.data.city} — wahan online audience bohat active hai, feature ka faida hoga. Aur category kya hai business ki? (food, fashion, electronics, salon, services...)`);
      break;
    }
    case 'ask_category': {
      session.data.category = t.slice(0, 60);
      session.step = 'pitch';
      replies.push(`${session.data.category} ke businesses ko hamaray platforms par bohat acha response milta hai.\n\n` + packagePitch(settings));
      replies.push(`Agar aap ko ye package theek lagta hai to bas *confirm* likh dein — main aap ki booking system me bana kar payment details bhej dunga. Koi sawal ho to wo bhi pooch sakte hain.`);
      break;
    }
    case 'pitch': {
      if (isYes(t) || /confirm/i.test(t)) {
        const lead = ctx.upsertLeadFromSession(session);
        session.leadId = lead.id;
        session.step = 'done';
        replies.push(paymentInstructions(settings, lead));
      } else if (isNo(t)) {
        session.step = 'pitch';
        replies.push('Koi baat nahi, bilkul relax ho kar soch lein. Main aap ko bas ye kehna chahunga ke feature ka sab se bara faida trust hai — log featured business par jaldi aitbaar karte hain. Jab bhi tayyar hon, "confirm" likh dein. 🙂');
      } else {
        const st = await geminiSmallTalk(session.history, settings, ctx.env);
        replies.push(st || 'Bohat acha sawal hai. Mukhtasir ye ke is package me design, content aur chaaron platforms par publishing sab shamil hai, aur kaam payment confirm honay ke baad shuru hota hai. Agar theek lage to "confirm" likh dein, main booking bana dunga.');
      }
      break;
    }
    case 'confirm':
    case 'done': {
      if (/screenshot|bhej di|paid|payment kar di|send kar di/i.test(t)) {
        replies.push('Shukriya! Aap ki payment ki tafseel hamari team ko bhej di hai — tasdeeq hotay hi aap ko confirm message aur material list mil jayegi (logo, photos, business ki mukhtasir tafseel). Thora sa wait karein. 🙏');
      } else {
        replies.push('Ji, main yahin hoon. Payment ke baad screenshot bhej dein, ya koi aur sawal ho to pooch lein. Hamari team aap ke feature par jald kaam shuru karegi.');
      }
      break;
    }
    default: {
      session.step = 'ask_business';
      replies.push('Maazrat, dobara shuru karte hain — aap ke business ka naam kya hai?');
    }
  }
  return done(ctx, replies);
}

function done(ctx, replies) {
  for (const r of replies) ctx.session.history.push({ from: 'agent', text: r, at: new Date().toISOString() });
  return { replies, session: ctx.session };
}

'use strict';
/* WhatsApp Cloud API transport — Node lib/whatsapp.js se port.
   Token + phone number id set hon to Graph API se asal send, warna simulated outbox
   (KV `outbox` key) — local testing/demo me bilkul wahi text jo asal jata.
   Env ab process.env ki jagah env bindings se aata hai. */
import { digits } from './textutil.js';

export function isStaffNumber(env, from) {
  const staff = (env.STAFF_NUMBERS || '').split(',').map(x => digits(x)).filter(Boolean);
  const f = digits(from);
  if (!f) return false;
  return staff.some(s => s.slice(-10) === f.slice(-10));
}

export function readOutbox(S) {
  return S.outbox || [];
}
function appendOutbox(S, entry) {
  S.outbox.push(entry);
  S.saveOutbox();
}

export async function sendWhatsApp(S, env, to, text) {
  const token = env.WHATSAPP_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (token && phoneId) {
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text } }),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) console.error('WhatsApp send failed', r.status, await r.text().catch(() => ''));
      return { ok: r.ok, simulated: false };
    } catch (e) {
      console.error('WhatsApp send error', e.message);
      return { ok: false, simulated: false, error: e.message };
    }
  }
  appendOutbox(S, { to: digits(to), text, at: new Date().toISOString(), simulated: true });
  return { ok: true, simulated: true };
}

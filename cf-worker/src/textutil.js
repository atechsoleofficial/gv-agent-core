'use strict';
/* Shared chhoti helpers — dono brains (Gemini/fallback), command parsing, scheduler.
   Node version (lib/textutil.js) se faithful port — koi change nahi. */
export function isYes(t) {
  return /^(yes|confirm|confirmed|ha+|haan|han|ji|ok|okay|kar do|kardo|theek hai|bilkul|done|proceed)\b/i.test(String(t || '').trim());
}
export function isNo(t) {
  return /^(no|cancel|nahi|nhi|rehne do|ruk jao|stop|mat karo)\b/i.test(String(t || '').trim());
}
export function digits(s) { return String(s || '').replace(/\D/g, ''); }
/* "yes, aur report bhi do" → remainder nikalna (confirmation ke baad baqi command) */
export function stripYesPrefix(t) {
  return String(t || '').replace(/^(yes|confirm|confirmed|haan|han|ji|ok|okay|theek hai|bilkul|kar do|kardo)[\s,.:;-]*/i, '').trim();
}
/* PKT (Asia/Karachi) me current date/time parts */
export function pktNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = {};
  fmt.formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    hourKey: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`
  };
}
export function money(n) { return 'Rs ' + Number(n || 0).toLocaleString('en-PK'); }

'use strict';
/* Signed session cookie — Node ke in-memory session Map ka Workers badal.
   Cookie `ac_sid` ki value: base64url(username) "." expiryMs "." HMAC-SHA256 hex.
   Key: SESSION_SECRET secret; set na ho to ADMIN_USER/ADMIN_PASS se derived fallback
   (sirf local dev asaani ke liye — production me SESSION_SECRET lazmi set karein). */

const enc = new TextEncoder();

function secretOf(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  return 'gv-fallback-' + (env.ADMIN_USER || 'admin') + '-' + (env.ADMIN_PASS || 'change-me');
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export async function makeSessionValue(env, username, ttlMs = 86400 * 1000) {
  const exp = Date.now() + ttlMs;
  const payload = b64url(username) + '.' + exp;
  const sig = await hmac(secretOf(env), payload);
  return payload + '.' + sig;
}

/* Valid + unexpired ho to username, warna null. */
export async function verifySessionValue(env, value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userB64, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!exp || exp < Date.now()) return null;
  const expected = await hmac(secretOf(env), userB64 + '.' + expStr);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try { return b64urlDecode(userB64); } catch (e) { return null; }
}

export function parseCookies(request) {
  const out = {};
  (request.headers.get('Cookie') || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) {
      try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* ignore */ }
    }
  });
  return out;
}

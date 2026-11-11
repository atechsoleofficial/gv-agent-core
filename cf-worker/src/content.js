'use strict';
/* Content factory: captions per platform style, a short script, and an SVG design card.
   Template/rule based by default; Gemini (if configured) only polishes the caption.
   Node lib/content.js se port — sirf Gemini key process.env ki jagah env binding se aati hai. */

export function esc(s) {
  return String(s || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function hashtags(lead) {
  const cat = (lead.category || 'Business').replace(/\s+/g, '');
  const city = (lead.city || 'Pakistan').replace(/\s+/g, '');
  return `#${cat} #${city} #StartupPakistan #GrowthVentures #PakistaniBusiness #EntrepreneurPakistan #BusinessFeature`;
}

export function generateCaptions(lead, platforms, settings) {
  const biz = lead.business || lead.name;
  const price = settings.packagePrice;
  const styles = [
    // News style (platform 1)
    `${biz} — ${lead.city || 'Pakistan'} se ubhartay huay business ki kahani!\n\n` +
    `${lead.category || 'Business'} ke shobay me apni pehchan bananay walay ${biz} ko aaj hum feature kar rahay hain. ` +
    `Mehnat, quality aur customer trust — yahi in ki kamyabi ka raaz hai.\n\n` +
    `Aap bhi apnay business ko hamaray 4 platforms par feature karwana chahte hain? Feature Package sirf Rs ${price.toLocaleString('en-PK')} me — DM karein ya WhatsApp par rabta karein.\n\n${hashtags(lead)}`,
    // Profile / biography style
    `FEATURED PROFILE: ${biz}\n\n` +
    `${lead.city || 'Pakistan'} ke ${lead.category || 'business'} sector ka aik numaya naam — ${biz}. ` +
    `Chhoti shuruaat se aaj ki pehchan tak ka safar waqai mutasir-kun hai.\n\n` +
    `Full feature hamaray tamam platforms par publish ho gaya hai. Apni story feature karwanay ke liye aaj hi rabta karein.\n\n${hashtags(lead)}`,
    // Community / engaging style
    `Kya aap ${biz} ko jantay hain?\n\n` +
    `${lead.city || 'Pakistan'} me ${lead.category || 'best quality'} ke liye mashhoor ${biz} ab hamaray platform par featured hai! ` +
    `In ki story har chhotay business ke liye aik misaal hai ke sahi direction me mehnat kabhi zaya nahi jati.\n\n` +
    `Comments me btayen, next feature kis business ka hona chahiye?\n\n${hashtags(lead)}`,
    // Short & punchy style
    `${biz} — ab FEATURED!\n${lead.category || 'Business'} | ${lead.city || 'Pakistan'}\n\n` +
    `Design, content aur publishing — poora feature hamaray 4 platforms par live hai. ` +
    `Apnay brand ko bhi yehi spotlight dein: Feature Package Rs ${price.toLocaleString('en-PK')}.\n\n${hashtags(lead)}`
  ];
  const out = {};
  platforms.forEach((p, i) => { out[p.id] = styles[i % styles.length]; });
  return out;
}

export function generateScript(lead) {
  const biz = lead.business || lead.name;
  return [
    `[Hook — 0:00-0:05]`,
    `"Agar aap ${lead.city || 'Pakistan'} me best ${lead.category || 'business'} dhoond rahay hain, to ye video aap ke liye hai!"`,
    ``,
    `[Intro — 0:05-0:20]`,
    `"Aaj hum feature kar rahay hain ${biz} ko — ${lead.city || 'Pakistan'} ke ${lead.category || 'business'} sector ka ubharta huwa naam."`,
    ``,
    `[Body — 0:20-0:45]`,
    `"${biz} ne quality aur customer trust ko apni pehchan banaya. Har roz barhti huwi demand is baat ka saboot hai ke logon ko yahan value milti hai." (Is hisay me client ki photos / shop ya office ki clips lagayen)`,
    ``,
    `[CTA — 0:45-0:60]`,
    `"Mazeed tafseel ke liye ${biz} se rabta karein — details description me hain. Aur agar aap bhi apnay business ko 4 baray platforms par feature karwana chahte hain, to Growth Ventures ko WhatsApp par message karein."`
  ].join('\n');
}

export function generateDesignSVG(lead, platform) {
  const biz = esc(lead.business || lead.name || 'Your Business');
  const cat = esc(lead.category || 'Business');
  const city = esc(lead.city || 'Pakistan');
  const plat = esc(platform ? platform.name.replace(/ —.*$/, '') : 'Growth Ventures');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b3d2e"/><stop offset="1" stop-color="#12805c"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#bg)"/>
  <rect x="40" y="40" width="1000" height="1000" fill="none" stroke="#f5c542" stroke-width="4" rx="24"/>
  <text x="540" y="150" font-family="Arial, sans-serif" font-size="42" fill="#f5c542" text-anchor="middle" letter-spacing="6">FEATURED BUSINESS</text>
  <text x="540" y="300" font-family="Arial, sans-serif" font-size="72" font-weight="bold" fill="#ffffff" text-anchor="middle">${biz}</text>
  <text x="540" y="390" font-family="Arial, sans-serif" font-size="44" fill="#d9f2e6" text-anchor="middle">${cat}</text>
  <text x="540" y="470" font-family="Arial, sans-serif" font-size="38" fill="#d9f2e6" text-anchor="middle">${city}, Pakistan</text>
  <rect x="290" y="540" width="500" height="3" fill="#f5c542"/>
  <text x="540" y="640" font-family="Arial, sans-serif" font-size="36" fill="#ffffff" text-anchor="middle">Mehnat • Quality • Trust</text>
  <text x="540" y="760" font-family="Arial, sans-serif" font-size="34" fill="#f5c542" text-anchor="middle">Featured on ${plat}</text>
  <text x="540" y="950" font-family="Arial, sans-serif" font-size="30" fill="#cfe8dc" text-anchor="middle">Growth Ventures — Feature Package</text>
</svg>`;
}

export async function maybePolishWithGemini(text, lead, env) {
  const key = env && env.GEMINI_API_KEY;
  if (!key) return text;
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
    const prompt = 'Improve this social media feature caption (keep Urdu/English mix, keep hashtags, keep it under 900 chars, do not change the business name "' + (lead.business || lead.name) + '"):\n\n' + text;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return text;
    const j = await r.json();
    const out = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    return (out && out.trim().length > 30) ? out.trim() : text;
  } catch (e) {
    return text; // graceful fallback
  }
}

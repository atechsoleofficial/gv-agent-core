'use strict';
/* Business knowledge seed + sales/content ke liye compat settings.
   Node lib/knowledge.js se port: seed wahi hai jo data/knowledge.json me tha;
   load/save ab KV store adapter (src/store.js) ke paas hai — S.knowledge object
   mutate hota hai aur S.saveKnowledge() dirty mark karta hai. */

export function seedKnowledge() {
  return {
    businessName: 'Growth Ventures',
    businessTagline: 'Boutique PR, Branding & Outreach agency — Lahore, Pakistan',
    ceo: 'Syed Shahzad Roshan Gillani (Founder & CEO)',
    contact: { phone: '+92 339 0079571', email: 'gventurespr@gmail.com', office: 'Office #10A, LG, Big City Plaza, Liberty Roundabout, Gulberg, Lahore' },
    agentName: 'GV Agent',
    salesAgentName: 'GV Sales Agent',
    package: {
      name: 'Feature Package',
      price: 10000,
      currency: 'PKR',
      inclusions: [
        'Professional design card / feature post (tasveer)',
        'Content / caption writing (Urdu + English mix)',
        'Short script (reel / voiceover ke liye)',
        'Publishing on all 4 media platforms',
        'Post links + performance report'
      ],
      deliveryDays: '2-3 working days (payment confirm + material milne ke baad)'
    },
    platforms: [
      { name: 'Startup Pakistan', link: '', followers: '', note: 'News / startup media platform' },
      { name: 'Platform 2 — naam confirm karna hai', link: '', followers: '', note: '' },
      { name: 'Platform 3 — naam confirm karna hai', link: '', followers: '', note: '' },
      { name: 'Platform 4 — naam confirm karna hai', link: '', followers: '', note: '' }
    ],
    paymentInstructions:
      'Raast / JazzCash / EasyPaisa: 03XX-XXXXXXX (Account Title: Growth Ventures)\n' +
      'Bank Transfer: Bank ____, IBAN PK____________________\n' +
      '(PLACEHOLDER — asal account details Settings / knowledge update se darj karein)',
    paymentNote: 'Payment ki tasdeeq hamesha GV team karegi — screenshot par andha aitbaar nahi. Bot sirf payment ki request bhejta hai, confirm staff karta hai.',
    behaviourRules: [
      'Data kabhi invent nahi karna — sirf tool results se jawab dena.',
      'Payment confirm, publish approve, ya client ko WhatsApp message bhejne se pehle staff se explicit confirmation lena.',
      'Naam ambiguous ho (aik se zyada match) to guess nahi karna — list de kar poochna.',
      'Har action ke baad state dobara parh kar verify karna aur concrete numbers ke saath summary dena.',
      'Client-facing messages me ATechSole ki koi service price nahi likhni; sirf GV ka apna Feature Package (Rs 10,000) discuss hota hai.',
      'Zuban: Roman Urdu / English mix, mukhtasir aur professional.'
    ],
    upsells: [
      'Silver social package Rs 1.5 Lac/month',
      'Gold content package Rs 3.5 Lac/month (30+ content)',
      'Platinum Rs 5 Lac/month'
    ],
    updatedAt: null
  };
}

/* Purane knowledge object me missing keys seed se bharna (Node loadKnowledge jaisa behaviour). */
export function fillKnowledge(k) {
  const s = seedKnowledge();
  for (const key of Object.keys(s)) if (k[key] === undefined) k[key] = s[key];
  if (k.package) for (const key of Object.keys(s.package)) if (k.package[key] === undefined) k.package[key] = s.package[key];
  return k;
}

/* Sales agent / content factory ko MVP-style settings object chahiye hota hai. */
export function compatSettings(S) {
  const k = S.knowledge;
  return {
    businessName: k.businessName,
    agentName: k.salesAgentName || k.agentName,
    packageName: k.package.name,
    packagePrice: k.package.price,
    packageInclusions: (k.package.inclusions || []).join(', '),
    paymentDetails: k.paymentInstructions,
    _platformNames: (S.data.platforms || []).map(p => p.name.replace(/ —.*$/, '')).join(', ')
  };
}

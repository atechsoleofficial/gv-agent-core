'use strict';
/* KV-backed store adapter — Node ke JSON-file store (lib/store.js) ka Workers roop.
   Har request/invocation ke liye aik instance: KvStore.load(kv) teeno keys parhta hai
   (`db`, `knowledge`, `outbox`), logic S.data / S.knowledge / S.outbox ko mutate karti
   hai, aur save()/saveKnowledge()/saveOutbox() sirf dirty mark karte hain — asal KV put
   persist() par hota hai (request ke end par worker khud call karta hai; agent/scheduler
   apne end par bhi persist kar dete hain).
   Node wala save() debounce (25ms) yahan nahi — Workers me request-scoped likhna hi sahi hai. */
import { seedKnowledge, fillKnowledge } from './knowledge.js';

export const STAGES = [
  'new', 'talking', 'payment_awaited', 'payment_confirmed',
  'material_pending', 'content_ready', 'approved', 'published', 'reported'
];
export const STAGE_LABEL = {
  new: 'New', talking: 'Talking', payment_awaited: 'Payment Awaited',
  payment_confirmed: 'Payment Confirmed', material_pending: 'Material Pending',
  content_ready: 'Content Ready', approved: 'Approved', published: 'Published', reported: 'Reported'
};

export function seedDb() {
  return {
    platforms: [
      { id: 'plat-1', name: 'Startup Pakistan', link: '', followers: '', type: 'News / Startup Media' },
      { id: 'plat-2', name: 'Platform 2 — naam confirm karna hai', link: '', followers: '', type: '' },
      { id: 'plat-3', name: 'Platform 3 — naam confirm karna hai', link: '', followers: '', type: '' },
      { id: 'plat-4', name: 'Platform 4 — naam confirm karna hai', link: '', followers: '', type: '' }
    ],
    leads: [],
    publishQueue: [],
    followups: [],          // {id, leadId, title, note, dueAt, status: open|done, createdAt, remindedAt, reminderTaskId}
    tasks: [],              // agent task log — har command ka record (plan, tool calls, summary)
    staffMemory: {},        // staffId -> {history:[], pendingAction, pendingPick, pendingCommand, collecting}
    agentSessions: {},      // lead sales agent sessions (web test console + WhatsApp)
    schedulerState: { lastDailyReportDate: '', lastFollowupScanHour: '' },
    invoiceSeq: 1000
  };
}

let counter = 0;
export function uid(prefix) {
  counter += 1;
  return prefix + '-' + Date.now().toString(36) + '-' + counter.toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}
export function nowISO() { return new Date().toISOString(); }

export class KvStore {
  constructor(kv) {
    this.kv = kv;
    this.data = null;
    this.knowledge = null;
    this.outbox = [];
    this.dirty = { db: false, knowledge: false, outbox: false };
  }

  /* KV se teeno keys load; missing/corrupt par seed + foran persist (Node ke first-boot jaisa). */
  static async load(kv) {
    const S = new KvStore(kv);
    const [dbRaw, knRaw, obRaw] = await Promise.all([
      kv.get('db'), kv.get('knowledge'), kv.get('outbox')
    ]);
    let seededAny = false;

    if (dbRaw) {
      try {
        S.data = JSON.parse(dbRaw);
        const s = seedDb();
        for (const k of Object.keys(s)) if (S.data[k] === undefined) S.data[k] = s[k];
      } catch (e) {
        console.error('KV db parse failed, starting from seed:', e.message);
        S.data = seedDb();
        seededAny = true;
      }
    } else {
      S.data = seedDb();
      seededAny = true;
    }

    if (knRaw) {
      try {
        S.knowledge = fillKnowledge(JSON.parse(knRaw));
      } catch (e) {
        console.error('KV knowledge parse failed, reseeding:', e.message);
        S.knowledge = seedKnowledge();
        seededAny = true;
      }
    } else {
      S.knowledge = seedKnowledge();
      seededAny = true;
    }

    if (obRaw) {
      try {
        const ob = JSON.parse(obRaw);
        S.outbox = Array.isArray(ob) ? ob : [];
      } catch (e) {
        S.outbox = [];
        seededAny = true;
      }
    } else {
      S.outbox = [];
      seededAny = true;
    }

    if (seededAny) {
      S.dirty.db = S.dirty.knowledge = S.dirty.outbox = true;
      await S.persist();
    }
    return S;
  }

  /* Node store.save() ka muqabla: synchronous dirty mark (har mutation path yahi call karta hai). */
  save() { this.dirty.db = true; }
  saveKnowledge() {
    if (this.knowledge) this.knowledge.updatedAt = nowISO();
    this.dirty.knowledge = true;
  }
  saveOutbox() { this.dirty.outbox = true; }

  /* Dirty keys ko KV me likhna. Request/invocation ke end par lazmi call karein. */
  async persist() {
    const jobs = [];
    if (this.dirty.db) jobs.push(this.kv.put('db', JSON.stringify(this.data)));
    if (this.dirty.knowledge) jobs.push(this.kv.put('knowledge', JSON.stringify(this.knowledge)));
    if (this.dirty.outbox) jobs.push(this.kv.put('outbox', JSON.stringify(this.outbox)));
    if (jobs.length) {
      await Promise.all(jobs);
      this.dirty.db = this.dirty.knowledge = this.dirty.outbox = false;
    }
  }
}

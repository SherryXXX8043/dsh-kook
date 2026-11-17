import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MONTH = 30 * 24 * 60 * 60 * 1000;

export class CompanionStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, pairedUsers: [], pending: {}, memories: {} };
    this.pendingWrite = Promise.resolve();
  }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.pairedUsers) || typeof value.pending !== 'object' || typeof value.memories !== 'object') throw new Error('Invalid companion store');
      this.data = value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  isPaired(id, initial = []) { return initial.includes(id) || this.data.pairedUsers.includes(id); }
  pendingFor(id) { return this.data.pending[id]; }
  async request(id) {
    const existing = this.data.pending[id];
    if (existing) return existing;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.data.pending[id] = { code, createdAt: Date.now() };
    await this.save();
    return this.data.pending[id];
  }
  async approve(code) {
    const entry = Object.entries(this.data.pending).find(([, value]) => value.code === code);
    if (!entry) return undefined;
    const [id] = entry;
    delete this.data.pending[id];
    if (!this.data.pairedUsers.includes(id)) this.data.pairedUsers.push(id);
    await this.save();
    return id;
  }
  async remember(userId, text, kind = 'conversation') {
    if (!text?.trim()) return;
    const list = this.data.memories[userId] ??= [];
    list.push({ id: randomUUID(), text: text.trim().slice(0, 2000), kind, createdAt: Date.now(), weight: 1 });
    this.data.memories[userId] = list.slice(-200);
    await this.save();
  }
  recall(userId, query, limit = 8, halfLifeMonths = 6) {
    const now = Date.now();
    const words = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []));
    return (this.data.memories[userId] ?? []).map(item => {
      const ageMonths = Math.max(0, (now - item.createdAt) / MONTH);
      const decay = Math.pow(0.5, ageMonths / Math.max(0.1, halfLifeMonths));
      const overlap = [...words].filter(word => item.text.toLowerCase().includes(word)).length;
      return { ...item, score: item.weight * decay * (1 + overlap), overlap };
    }).filter(item => item.score >= 0.08 && (words.size === 0 || item.overlap > 0)).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async save() {
    const operation = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await rename(temp, this.path);
    });
    this.pendingWrite = operation.catch(() => {});
    return operation;
  }
}

export async function readKnowledge(path, maxBytes = 1024 * 1024) {
  if (!path) return [];
  try {
    const text = await readFile(path, 'utf8');
    return text.slice(0, maxBytes).split(/\n\s*\n/).map(item => item.trim()).filter(Boolean).slice(0, 1000);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function findKnowledge(entries, query, limit = 5) {
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  return entries.map(text => ({ text, score: [...words].filter(word => text.toLowerCase().includes(word)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.text);
}

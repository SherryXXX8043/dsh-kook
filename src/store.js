import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Only routing metadata is stored here; DSH owns conversation persistence. */
export class RouteStore {
  constructor(path) { this.path = path; this.routes = new Map(); this.pending = Promise.resolve(); }
  async load() {
    let raw;
    try { raw = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (raw.version !== 1 || !Array.isArray(raw.routes)) throw new Error('Invalid KOOK route store');
    for (const entry of raw.routes) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') throw new Error('Invalid KOOK route entry');
      this.routes.set(...entry);
    }
  }
  get(key) { return this.routes.get(key); }
  async set(key, id) {
    // Publish the in-memory change only after the disk commit succeeds.
    const operation = this.pending.then(async () => {
      const next = new Map(this.routes);
      if (id === undefined) next.delete(key); else next.set(key, id);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, routes: [...next] }, null, 2), { mode: 0o600 });
      await rename(temp, this.path);
      this.routes = next;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

import { KookClient, KWSStates } from '@kookapp/js-sdk';
import { kookImageUrl, parseImageCard } from './images.js';

// SDK errors can contain gateway URLs, tokens or message bodies. Report only
// our fixed status strings; never forward SDK log arguments to the host.
const quietLogger = Object.freeze(Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark'].map(key => [key, () => {}]),
));
const defaultClientFactory = config => new KookClient(config);

/** start() schedules connection without waiting for the network. */
export class KookTransport {
  constructor({ token, onMessage = () => {}, onStatus = () => {}, logger,
    clientFactory = defaultClientFactory, retryBaseMs = 1000, retryMaxMs = 60000,
    requestTimeoutMs = 10000 }) {
    if (typeof token !== 'string' || !token.trim()) throw new Error('KOOK token is required');
    Object.assign(this, { token, onMessage, onStatus, logger, clientFactory,
      retryBaseMs, retryMaxMs, requestTimeoutMs });
    this.running = false;
    this.generation = 0;
    this.failures = 0;
    this.requests = new Set();
    this.seen = new Map();
    this.listeners = new Map();
  }
  status(value) {
    try { this.onStatus(value); } catch { /* Isolate host callbacks. */ }
  }
  start() {
    if (this.stopping) {
      this.restartRequested = true;
      return;
    }
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.failures = 0;
    this.status('connecting');
    this.queue(0);
  }
  queue(delay) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.connecting) {
        this.queue(Math.max(1, this.retryBaseMs));
      } else {
        const pending = this.attempt();
        this.connecting = pending;
        void pending.finally(() => {
          if (this.connecting === pending) this.connecting = undefined;
        });
      }
    }, delay);
    this.timer.unref?.();
  }
  retry() {
    if (!this.running || this.timer) return;
    this.status('reconnecting');
    this.queue(Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.failures++, 16)));
  }
  async disposeClient(client) {
    if (!client) return;
    const listeners = this.listeners.get(client) ?? [];
    this.listeners.delete(client);
    for (const [event, listener] of listeners) client.off(event, listener);
    try { await client.destroy(); } catch { /* SDK errors may contain secrets. */ }
  }
  async attempt() {
    const generation = this.generation;
    let client;
    const current = () => this.running && generation === this.generation && this.client === client;
    try {
      const previous = this.client;
      this.client = undefined;
      await this.disposeClient(previous);
      if (!this.running || generation !== this.generation) return;
      client = await this.clientFactory({ botToken: this.token, compression: false,
        autoReconnect: true, logger: quietLogger, requestTimeoutMs: this.requestTimeoutMs });
      if (!this.running || generation !== this.generation) {
        await this.disposeClient(client);
        return;
      }
      this.client = client;
      const listeners = [
        ['event', event => { if (current()) this.receive(event); }],
        ['stateChange', state => {
          if (!current()) return;
          if (state === KWSStates.Connected) {
            this.failures = 0;
            this.status('online');
          } else if (state === KWSStates.Failed) {
            this.status('offline');
            this.retry();
          }
        }],
        ['reconnecting', () => { if (current()) this.status('reconnecting'); }],
        ['close', () => { if (current()) this.status('offline'); }],
        ['error', () => { if (current()) this.status('offline'); }],
      ];
      this.listeners.set(client, listeners);
      for (const [event, listener] of listeners) client.on(event, listener);
      // The SDK owns gateway negotiation, heartbeats, RESUME and reconnection.
      await client.connect();
    } catch {
      if (current() || (this.running && generation === this.generation && !client)) {
        this.client = undefined;
        await this.disposeClient(client);
        if (this.running && generation === this.generation) {
          this.status('offline');
          this.retry();
        }
      }
    }
  }
  receive(event) {
    if (!this.running || !event || ![1, 2, 9, 10].includes(event.type)) return;
    if (event.extra?.author?.bot || event.author_id === this.client?.me?.id) return;
    const kind = event.channel_type === 'GROUP' ? 'channel'
      : event.channel_type === 'PERSON' ? 'private' : null;
    if (!kind || typeof event.content !== 'string' || !event.msg_id || !event.author_id) return;
    const targetId = kind === 'channel' ? event.target_id : event.author_id;
    if (typeof targetId !== 'string') return;
    const id = String(event.msg_id);
    const key = `${kind}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, true);
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value);
    const card = event.type === 10 ? parseImageCard(event.content) : undefined;
    if (event.type === 10 && !card) return;
    const attachment = event.extra?.attachments;
    const message = { id, kind, targetId, authorId: String(event.author_id),
      text: card?.text ?? (event.type === 2 ? '' : event.content), isBot: false,
      ...(card ? { images: card.images } : event.type === 2 ? { images: [{
        url: typeof attachment?.url === 'string' && attachment.url ? attachment.url : event.content,
        name: typeof attachment?.name === 'string' ? attachment.name : undefined,
      }] } : {}) };
    try { Promise.resolve(this.onMessage(message)).catch(() => {}); } catch { /* isolated */ }
  }
  async send(target, text) {
    return this.sendMessage(target, 1, text);
  }
  async sendImage(target, { data, mediaType, name }, signal) {
    this.validateTarget(target);
    const form = new FormData();
    form.append('file', new Blob([data], { type: mediaType }), name);
    const uploaded = await this.request('/api/v3/asset/create', form, true, signal);
    const url = kookImageUrl(uploaded?.url);
    return this.sendMessage(target, 2, url, signal);
  }
  validateTarget(target) {
    if (!this.running || !this.client) throw new Error('KOOK transport is not started');
    if (!target || !['channel', 'private'].includes(target.kind) ||
      typeof target.targetId !== 'string' || !target.targetId) throw new Error('Invalid KOOK message target');
  }
  async sendMessage(target, type, content, signal) {
    this.validateTarget(target);
    if (typeof content !== 'string') throw new Error('Invalid KOOK message content');
    return this.request(target.kind === 'channel' ? '/api/v3/message/create' : '/api/v3/direct-message/create',
      { target_id: target.targetId, type, content }, false, signal);
  }
  async request(path, data, formData = false, signal) {
    if (!this.running || !this.client) throw new Error('KOOK transport is not started');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.requests.add(controller);
    let timer;
    let abortListener;
    try {
      controller.signal.throwIfAborted();
      const cancelled = new Promise((_, reject) => {
        abortListener = () => reject(new Error('KOOK send cancelled or timed out'));
        controller.signal.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      });
      // A lost POST response may already have been accepted; never retry uploads or messages.
      const request = this.client.api.request(path, 'POST', data, formData,
        { timeoutMs: this.requestTimeoutMs, signal: controller.signal, retryOnRateLimit: false });
      const result = await Promise.race([request, cancelled]);
      if (!result?.success || result.code !== 0) throw new Error('KOOK rejected message');
      return result.data;
    } catch {
      throw new Error('KOOK message delivery failed');
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      signal?.removeEventListener('abort', onAbort);
      this.requests.delete(controller);
    }
  }
  stop() {
    this.restartRequested = false;
    if (this.stopping) return this.stopping;
    this.running = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.requests) controller.abort();
    const client = this.client;
    this.client = undefined;
    const connecting = this.connecting;
    this.seen.clear();
    this.status('stopped');
    const pending = (async () => {
      await this.disposeClient(client);
      await connecting;
    })();
    this.stopping = pending;
    void pending.finally(() => {
      if (this.stopping !== pending) return;
      this.stopping = undefined;
      if (this.restartRequested) {
        this.restartRequested = false;
        this.start();
      }
    });
    return pending;
  }
}

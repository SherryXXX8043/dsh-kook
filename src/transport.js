const quietLogger = Object.freeze(Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark'].map(key => [key, () => {}]),
));
async function defaultClientFactory(config) {
  const { Client } = await import('kook-client');
  return new Client(config);
}

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
  }
  status(value) {
    try { this.onStatus(value); } catch { /* Isolate host callbacks. */ }
  }
  start() {
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
      void this.attempt();
    }, delay);
    this.timer.unref?.();
  }
  retry() {
    if (!this.running || this.timer) return;
    this.status('reconnecting');
    this.queue(Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.failures++, 16)));
  }
  async attempt() {
    if (!this.running || this.connecting) return;
    const generation = this.generation;
    this.connecting = true;
    let failed = false;
    try {
      if (!this.client) {
        const client = await this.clientFactory({ token: this.token, mode: 'websocket',
          ignore: 'bot', compress: false, autoReconnect: false,
          handleProcessErrors: false, logLevel: 'off', timeout: this.requestTimeoutMs });
        if (!this.running || generation !== this.generation) {
          await client.disconnect();
          return;
        }
        client.logger = quietLogger;
        this.client = client;
        const receiver = client.receiver;
        // Replace cache-dependent conversion. The raw event is packet.d, not {s,d,sn}.
        // This receiver is owned exclusively by this transport.
        receiver.removeAllListeners('event');
        this.eventListener = event => this.receive(event);
        this.disconnectListener = () => {
          if (this.connecting) this.disconnectedDuringConnect = true;
          else this.retry();
        };
        receiver.on('event', this.eventListener);
        receiver.on('disconnected', this.disconnectListener);
      }
      const receiver = this.client.receiver;
      this.disconnectedDuringConnect = false;
      // Bypass Client.connect's guild/member caches: restricted bots cannot load them.
      if (receiver.canResume?.() && receiver.sn > 0 && !this.freshConnection) {
        try { await receiver.reconnect(); }
        catch { this.freshConnection = true; throw new Error('KOOK resume failed'); }
      } else {
        this.freshConnection = false;
        await receiver.connect();
      }
      if (!this.running || generation !== this.generation) return;
      if (this.disconnectedDuringConnect) throw new Error('KOOK disconnected during connection');
      this.failures = 0;
      this.status('online');
    } catch {
      failed = true;
      // Never forward SDK/axios errors: they may contain token-bearing gateway URLs.
      if (this.running && generation === this.generation) this.status('offline');
    } finally {
      this.connecting = false;
      if (generation !== this.generation && this.running) this.queue(0);
      else if (failed && this.running) this.retry();
    }
  }
  receive(event) {
    if (!this.running || !event || ![1, 9].includes(event.type)) return;
    const kind = event.channel_type === 'GROUP' ? 'channel'
      : event.channel_type === 'PERSON' ? 'private' : null;
    if (!kind || typeof event.content !== 'string' || !event.msg_id || !event.author_id) return;
    const targetId = kind === 'channel' ? event.target_id : event.author_id;
    if (typeof targetId !== 'string') return;
    const id = String(event.msg_id);
    if (this.seen.has(id)) return;
    this.seen.set(id, true);
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value);
    const message = { id, kind, targetId, authorId: String(event.author_id),
      text: event.content, isBot: Boolean(event.extra?.author?.bot) };
    try { Promise.resolve(this.onMessage(message)).catch(() => {}); } catch { /* isolated */ }
  }
  async send(target, text) {
    if (!this.running || !this.client) throw new Error('KOOK transport is not started');
    if (!target || !['channel', 'private'].includes(target.kind) ||
      typeof target.targetId !== 'string' || !target.targetId || typeof text !== 'string') {
      throw new Error('Invalid KOOK message target or text');
    }
    const controller = new AbortController();
    this.requests.add(controller);
    let timer;
    let abortListener;
    try {
      const cancelled = new Promise((_, reject) => {
        abortListener = () => reject(new Error('KOOK send cancelled or timed out'));
        controller.signal.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      });
      const request = this.client.request.post(
        target.kind === 'channel' ? '/v3/message/create' : '/v3/direct-message/create',
        { target_id: target.targetId, type: 1, content: text },
        { timeout: this.requestTimeoutMs, signal: controller.signal },
      );
      const result = await Promise.race([request, cancelled]);
      if (result?.code !== 0) throw new Error('KOOK rejected message');
      return result.data;
    } catch {
      throw new Error('KOOK message delivery failed');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abortListener);
      this.requests.delete(controller);
    }
  }
  async stop() {
    this.running = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.requests) controller.abort();
    const client = this.client;
    this.client = undefined;
    if (client) {
      client.receiver.off('event', this.eventListener);
      client.receiver.off('disconnected', this.disconnectListener);
      try { await client.disconnect(); } catch { /* Errors may contain secrets. */ }
    }
    this.seen.clear();
    this.status('stopped');
  }
}

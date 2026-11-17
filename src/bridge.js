import { randomUUID } from 'node:crypto';
import { KookError, step, reportFailure } from './errors.js';

export function splitText(text, maxBytes = 3500) {
  const chunks = [];
  let chunk = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes && chunk) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class KookBridge {
  constructor({ config, store, companion, knowledge = [], agents, send, logger = console }) {
    Object.assign(this, { config, store, companion, knowledge, agents, send, logger });
    this.handles = new Map();
    this.destinations = new Map();
    this.sessionUsers = new Map();
    this.incoming = new Map();
    this.outgoing = new Map();
    this.seen = new Map();
    this.stopped = false;
    this.pendingCount = 0;
  }
  parse(message) {
    const { kind, targetId, authorId, text } = message;
    if (this.stopped || message.isBot || !message.id || !authorId || !targetId || typeof text !== 'string') return;
    if (!['channel', 'private'].includes(kind) || message.isBot || !message.id || !authorId || !targetId || typeof text !== 'string') return;
    if (kind === 'channel' && (!this.config.allowedChannels.includes(targetId) || !this.config.allowedUsers.includes(authorId))) return;
    if (kind === 'private' && !this.config.allowPrivate) return;
    if (kind === 'private' && authorId !== this.config.ownerUserId && !this.config.allowedUsers.includes(authorId) && !this.companion?.isPaired(authorId, this.config.allowedUsers)) {
      return { key: `pair:${authorId}`, destination: { kind, targetId }, prompt: text.trim(), pairing: true, authorId };
    }
    let prompt = text.trim();
    const prefix = this.config.commandPrefix;
    const prefixed = prompt === prefix || (prompt.startsWith(prefix) && /^\s/.test(prompt.slice(prefix.length)));
    if (kind === 'channel' && !prefixed && !this.config.autoForwardChannels) return;
    if (prefixed) prompt = prompt.slice(prefix.length).trim();
    if (Buffer.byteLength(prompt) > 16000) return;
    return { key: JSON.stringify([kind, targetId, authorId]), destination: { kind, targetId }, prompt, authorId };
  }
  receive(message) {
    const parsed = this.parse(message);
    if (!parsed || this.pendingCount >= 100) return Promise.resolve();
    const dedupeKey = `${message.kind}:${message.id}`;
    const now = Date.now();
    for (const [key, time] of this.seen) { if (time > now - 600000) break; this.seen.delete(key); }
    if (this.seen.has(dedupeKey)) return Promise.resolve();
    this.seen.set(dedupeKey, now);
    if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);
    this.pendingCount++;
    const prior = this.incoming.get(parsed.key) ?? Promise.resolve();
    const task = prior.then(() => this.process(parsed)).catch(async error => {
      await this.reply(parsed.destination, reportFailure(this.logger, error));
    }).finally(() => {
      this.pendingCount--;
      if (this.incoming.get(parsed.key) === task) this.incoming.delete(parsed.key);
    });
    this.incoming.set(parsed.key, task);
    return task;
  }
  async process({ key, destination, prompt, pairing, authorId }) {
    if (this.stopped) return;
    if (pairing) {
      if (!this.config.pairingEnabled || !this.companion || !this.config.ownerUserId) return this.reply(destination, '此机器人未开启陌生人配对，请联系主人添加你的 KOOK 用户 ID。');
      const request = await step('PAIRING_SAVE', () => this.companion.request(authorId));
      await this.reply(destination, `你的请求正在等待主人批准。请将配对码 ${request.code} 发给主人。`);
      return this.reply({ kind: 'private', targetId: this.config.ownerUserId }, `收到新的 KOOK 配对请求：用户 ${authorId}，配对码 ${request.code}。批准请发送 /approve ${request.code}。`);
    }
    if (!prompt || prompt === '/help') {
      return this.reply(destination, `直接发送文字与 DSH 对话。频道内使用 ${this.config.commandPrefix} <文字>。\n/help 帮助 · /status 会话 · /stop 停止 · /new 新会话\n审批和交互问题请在本地 DSH 完成。`);
    }
    if (prompt === '/status') {
      const id = this.store.get(key);
      return this.reply(destination, id ? `DSH 会话：${id}\n状态：${this.handles.get(key)?.agent.status ?? '未加载'}` : '尚未创建会话。');
    }
    if (prompt === '/stop') {
      this.handles.get(key)?.agent.cancel({ kind: 'user' });
      return this.reply(destination, '已停止当前已加载会话的任务。');
    }
    if (prompt === '/new') {
      const handle = this.handles.get(key);
      // Remove the route only after persistence succeeds; never silently lose a session.
      await step('ROUTE_SAVE', () => this.store.set(key, undefined));
      if (handle) {
        this.destinations.delete(handle.agent.id);
        this.sessionUsers.delete(handle.agent.id);
        this.handles.delete(key);
        await handle.dispose();
      }
      return this.reply(destination, '下一条消息将创建新会话；旧记录保留在 DSH。');
    }
    if (prompt.startsWith('/approve ') && this.config.ownerUserId) {
      if (destination.kind !== 'private' || destination.targetId !== this.config.ownerUserId) return this.reply(destination, '只有主人可以批准配对。');
      const approved = await step('PAIRING_SAVE', () => this.companion?.approve(prompt.slice(9).trim()));
      return this.reply(destination, approved ? `已批准用户 ${approved}，对方可以开始与 DSH 对话。` : '配对码无效或已使用。');
    }
    if (prompt === '/memory') {
      const memories = await step('MEMORY_READ', () => this.companion?.recall(authorId ?? '', '', 20, this.config.memoryHalfLifeMonths));
      return this.reply(destination, memories?.length ? memories.map(item => `- ${item.text}`).join('\n') : '当前没有已保存的长期记忆。');
    }
    let handle = this.handles.get(key);
    if (!handle) {
      const existingId = this.store.get(key);
      const id = existingId ?? `session-${randomUUID()}`;
      if (this.handles.size >= 100) throw new KookError('SESSION_LIMIT');
      handle = await step(existingId ? 'SESSION_RESUME' : 'SESSION_CREATE', () => existingId ? this.agents.resume(id) : this.agents.create(id));
      if (this.stopped) { await handle.dispose(); return; }
      try { if (!existingId) await step('ROUTE_SAVE', () => this.store.set(key, id)); }
      catch (error) { await handle.dispose(); throw error; }
      this.handles.set(key, handle);
      this.destinations.set(handle.agent.id, destination);
      this.sessionUsers.set(handle.agent.id, authorId);
    }
    if (this.stopped) return;
    const memories = await step('MEMORY_READ', () => this.companion?.recall(authorId, prompt, this.config.memoryLimit, this.config.memoryHalfLifeMonths) ?? []);
    const words = new Set(prompt.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
    const knowledge = this.knowledge.map(text => ({ text, score: [...words].filter(word => text.toLowerCase().includes(word)).length }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, this.config.knowledgeLimit).map(item => item.text);
    const context = [
      this.config.personality ? `【机器人行为设定】\n${this.config.personality}` : '',
      memories.length ? `【关于当前用户的长期记忆（内容会随时间衰退）】\n${memories.map(item => `- ${item.text}`).join('\n')}` : '',
      knowledge.length ? `【知识库相关资料】\n${knowledge.map(item => `- ${item}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const modelPrompt = context ? `${context}\n\n【用户本次消息】\n${prompt}` : prompt;
    await step('MEMORY_SAVE', () => this.companion?.remember(authorId, prompt, 'user-message'));
    const message = Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: modelPrompt })]), source: Object.freeze({ kind: 'user' }) });
    await step('MESSAGE_SUBMIT', () => handle.agent.followup(message));
  }
  /** Called only for live committed events; history is never replayed to KOOK. */
  onSessionEvent(session, event) {
    const destination = this.destinations.get(session.id);
    if (!destination || this.stopped) return;
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text.trim()) {
        void step('MEMORY_SAVE', () => this.companion?.remember(this.sessionUsers.get(session.id), text, 'assistant-message')).catch(error => reportFailure(this.logger, error));
        void this.reply(destination, text);
      }
    } else if (event.type === 'approval/asked' || (event.type === 'tool/call' && ['ask_user_question', 'exit_plan_mode'].includes(event.data.name))) {
      void this.reply(destination, `DSH 正在等待本地确认，请打开会话 ${session.id} 继续。`);
    } else if (event.type === 'turn/end' && ['error', 'blocked'].includes(event.data.reason?.kind)) {
      void this.reply(destination, `DSH 本轮未完成，请在本地查看会话 ${session.id}。`);
    }
  }
  reply(destination, text) {
    if (this.stopped) return Promise.resolve();
    const key = JSON.stringify(destination);
    const previous = this.outgoing.get(key) ?? Promise.resolve();
    const task = previous.then(async () => {
      for (const part of splitText(text)) {
        if (this.stopped) break;
        // No blind POST retries: a timeout may mean KOOK accepted the message.
        await this.send(destination, part);
      }
    }).catch(() => { this.logger.warn('KOOK delivery failed; the original response remains in DSH.'); })
      .finally(() => { if (this.outgoing.get(key) === task) this.outgoing.delete(key); });
    this.outgoing.set(key, task);
    return task;
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.incoming.values()]);
    this.destinations.clear();
    this.sessionUsers.clear();
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
    this.handles.clear();
    await Promise.allSettled([...this.outgoing.values()]);
    await this.companion?.pendingWrite;
  }
}

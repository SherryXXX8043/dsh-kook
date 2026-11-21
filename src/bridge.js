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
  constructor({ config, store, companion, knowledge = [], agents, send, images, logger = console }) {
    Object.assign(this, { config, store, companion, knowledge, agents, send, images, logger });
    this.imageRequests = new Map();
    this.imageControllers = new Map();
    this.lifetime = new AbortController();
    this.handles = new Map();
    this.destinations = new Map();
    this.sessionUsers = new Map();
    this.incoming = new Map();
    this.outgoing = new Map();
    this.seen = new Map();
    this.stopped = false;
    this.pendingCount = 0;
  }
  currentHandle(key) {
    const handle = this.handles.get(key);
    if (handle?.isCurrent && !handle.isCurrent()) {
      this.handles.delete(key);
      this.destinations.delete(handle.agent.id);
      this.sessionUsers.delete(handle.agent.id);
      return undefined;
    }
    return handle;
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
    const images = Array.isArray(message.images) ? message.images.map(image => ({ ...image })) : [];
    const mentioned = kind === 'channel' && this.config.mentionWakeup !== false &&
      message.mentionedBot === true && typeof message.botId === 'string' && /^\d+$/.test(message.botId);
    let prompt = mentioned ? text.split(`(met)${message.botId}(met)`).join('').trim() : text.trim();
    const prefix = this.config.commandPrefix;
    const prefixed = prompt === prefix || (prompt.startsWith(prefix) && /^\s/.test(prompt.slice(prefix.length)));
    const needsImageRequest = kind === 'channel' && !prefixed && !mentioned && !this.config.autoForwardChannels;
    if (needsImageRequest && !images.length) return;
    if (prefixed) prompt = prompt.slice(prefix.length).trim();
    if (Buffer.byteLength(prompt) > 16000) return;
    return { key: JSON.stringify([kind, targetId, authorId]), destination: { kind, targetId }, prompt, authorId, images, needsImageRequest };
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
    if (['/stop', '/new'].includes(parsed.prompt) && !parsed.images?.length) {
      for (const controller of this.imageControllers.get(parsed.key) ?? []) controller.abort();
    }
    if (parsed.images?.length) {
      parsed.imageController = new AbortController();
      const controllers = this.imageControllers.get(parsed.key) ?? new Set();
      controllers.add(parsed.imageController);
      this.imageControllers.set(parsed.key, controllers);
    }
    this.pendingCount++;
    const prior = this.incoming.get(parsed.key) ?? Promise.resolve();
    const task = prior.then(() => this.process(parsed)).catch(async error => {
      const retry = parsed.images?.length && parsed.needsImageRequest
        ? `\n频道接图请求已消费。重试前请先发送 ${this.config.commandPrefix} /image <问题>，再发送图片。` : '';
      await this.reply(parsed.destination, reportFailure(this.logger, error) + retry);
    }).finally(() => {
      this.pendingCount--;
      const controllers = this.imageControllers.get(parsed.key);
      controllers?.delete(parsed.imageController);
      if (controllers?.size === 0) this.imageControllers.delete(parsed.key);
      if (this.incoming.get(parsed.key) === task) this.incoming.delete(parsed.key);
    });
    this.incoming.set(parsed.key, task);
    return task;
  }
  async process({ key, destination, prompt, pairing, authorId, images = [], needsImageRequest, imageController }) {
    if (this.stopped || imageController?.signal.aborted) return;
    const hasImages = images.length > 0;
    if (hasImages) {
      const pending = this.imageRequests.get(key);
      this.imageRequests.delete(key);
      const armed = pending?.expiresAt > Date.now();
      if (needsImageRequest && !armed) return;
      // A caption on this exact image is authoritative; a prior /image prompt only fills an empty caption.
      if (armed && !prompt) prompt = pending.prompt;
      if (prompt === '/image' || prompt.startsWith('/image ')) prompt = prompt.slice(6).trim();
      prompt ||= '请根据上下文查看这张图片；没有其他问题时，请简要描述图片内容。';
    }
    if (pairing) {
      if (!this.config.pairingEnabled || !this.companion || !this.config.ownerUserId) return this.reply(destination, '此机器人未开启陌生人配对，请联系主人添加你的 KOOK 用户 ID。');
      const request = await step('PAIRING_SAVE', () => this.companion.request(authorId));
      await this.reply(destination, `你的请求正在等待主人批准。请将配对码 ${request.code} 发给主人。`);
      return this.reply({ kind: 'private', targetId: this.config.ownerUserId }, `收到新的 KOOK 配对请求：用户 ${authorId}，配对码 ${request.code}。批准请发送 /approve ${request.code}。`);
    }
    if (!hasImages && (!prompt || prompt === '/help')) {
      const mentionHelp = this.config.mentionWakeup !== false ? '也可在频道中 @机器人 后发送正文或 /status、/stop 等命令。同一条消息可 @机器人、附图并填写问题，直接识图（请选择机器人账号，不是同名角色）。\n' : '';
      return this.reply(destination, `直接发送文字或图片与 DSH 对话（看图需要支持图片的模型）。频道内使用 ${this.config.commandPrefix} <文字>。\n${mentionHelp}频道未开启自动转发时，先发 ${this.config.commandPrefix} /image <问题>${this.config.mentionWakeup !== false ? '（或 @机器人 /image <问题>）' : ''}，再在两分钟内发一张图。\n/help 帮助 · /image <问题> 接收下一张图 · /status 会话 · /stop 停止 · /new 新会话\n需要收图时可说“把工作目录中的某张图片发给我”。\n审批和交互问题请在本地 DSH 完成。`);
    }
    if (!hasImages && (prompt === '/image' || prompt.startsWith('/image '))) {
      for (const [route, request] of this.imageRequests) if (request.expiresAt <= Date.now()) this.imageRequests.delete(route);
      if (!this.imageRequests.has(key) && this.imageRequests.size >= 100) throw new KookError('IMAGE_BUSY');
      this.imageRequests.set(key, { prompt: prompt.slice(6).trim() || '请描述这张图片。', expiresAt: Date.now() + 120000 });
      return this.reply(destination, '请在两分钟内发送一张图片；仅接收你在当前聊天中的下一张图。');
    }
    if (!hasImages && prompt === '/status') {
      const id = this.store.get(key);
      return this.reply(destination, id ? `DSH 会话：${id}\n状态：${this.handles.get(key)?.agent.status ?? '未加载'}` : '尚未创建会话。');
    }
    if (!hasImages && prompt === '/stop') {
      this.imageRequests.delete(key);
      this.currentHandle(key)?.agent.cancel({ kind: 'user' });
      return this.reply(destination, '已停止当前已加载会话的任务。');
    }
    if (!hasImages && prompt === '/new') {
      this.imageRequests.delete(key);
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
    if (!hasImages && prompt.startsWith('/approve ') && this.config.ownerUserId) {
      if (destination.kind !== 'private' || destination.targetId !== this.config.ownerUserId) return this.reply(destination, '只有主人可以批准配对。');
      const approved = await step('PAIRING_SAVE', () => this.companion?.approve(prompt.slice(9).trim()));
      return this.reply(destination, approved ? `已批准用户 ${approved}，对方可以开始与 DSH 对话。` : '配对码无效或已使用。');
    }
    if (!hasImages && prompt === '/memory') {
      const memories = await step('MEMORY_READ', () => this.companion?.recall(authorId ?? '', '', 20, this.config.memoryHalfLifeMonths));
      return this.reply(destination, memories?.length ? memories.map(item => `- ${item.text}`).join('\n') : '当前没有已保存的长期记忆。');
    }
    let imageBlocks = [];
    if (hasImages) {
      if (!this.images) throw new KookError('IMAGE_UNAVAILABLE');
      const controller = imageController;
      try {
        imageBlocks = await this.images.admit(images, AbortSignal.any([this.lifetime.signal, controller.signal]));
        if (controller.signal.aborted) return;
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
      if (this.stopped) return;
    }
    let handle = this.currentHandle(key);
    if (!handle) {
      const existingId = this.store.get(key);
      const id = existingId ?? `session-${randomUUID()}`;
      if ([...this.handles.entries()].some(([route, current]) => route !== key && current.agent.id === id)) throw new KookError('SESSION_OWNED');
      if (this.handles.size >= 100) throw new KookError('SESSION_LIMIT');
      handle = await step(existingId ? 'SESSION_RESUME' : 'SESSION_CREATE', () => existingId ? this.agents.resume(id) : this.agents.create(id));
      if (this.stopped || imageController?.signal.aborted) { await handle.dispose(); return; }
      if ([...this.handles.entries()].some(([route, current]) => route !== key && current.agent.id === handle.agent.id)) {
        if (handle.borrowed) await handle.dispose();
        throw new KookError('SESSION_OWNED');
      }
      try { if (!existingId) await step('ROUTE_SAVE', () => this.store.set(key, id)); }
      catch (error) { await handle.dispose(); throw error; }
      this.handles.set(key, handle);
      this.destinations.set(handle.agent.id, destination);
      this.sessionUsers.set(handle.agent.id, authorId);
    }
    if (this.stopped || imageController?.signal.aborted) return;
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
    if (this.stopped || imageController?.signal.aborted) return;
    await step('MEMORY_SAVE', () => this.companion?.remember(authorId, prompt, 'user-message'));
    if (this.stopped || imageController?.signal.aborted) return;
    const content = [{ type: 'text', text: modelPrompt }, ...imageBlocks].map(block => Object.freeze(block));
    const message = Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze(content), source: Object.freeze({ kind: 'user' }) });
    if (handle.isCurrent && !handle.isCurrent()) throw new KookError('SESSION_OWNED');
    await step('MESSAGE_SUBMIT', () => handle.agent.followup(message));
  }
  /** Called only for live committed events; history is never replayed to KOOK. */
  onSessionEvent(session, event) {
    const destination = this.destinations.get(session.id);
    if (!destination || this.stopped) return;
    const handles = [...this.handles.values()].filter(handle => handle.agent.id === session.id);
    if (handles.some(handle => handle.isCurrent && (!handle.isCurrent() || handle.agent.session !== session))) return;
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
  queueDelivery(destination, operation) {
    if (this.stopped) return Promise.reject(new Error('KOOK bridge stopped'));
    const key = JSON.stringify(destination);
    const previous = this.outgoing.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => {
      if (this.stopped) throw new Error('KOOK bridge stopped');
      return operation();
    });
    this.outgoing.set(key, task);
    void task.finally(() => { if (this.outgoing.get(key) === task) this.outgoing.delete(key); }).catch(() => {});
    return task;
  }
  reply(destination, text) {
    if (this.stopped) return Promise.resolve();
    return this.queueDelivery(destination, async () => {
      for (const part of splitText(text)) {
        if (this.stopped) break;
        await this.send(destination, part);
      }
    }).catch(() => { this.logger.warn('KOOK delivery failed; the original response remains in DSH.'); });
  }
  async stop() {
    this.stopped = true;
    this.lifetime.abort();
    this.imageRequests.clear();
    await Promise.allSettled([...this.incoming.values()]);
    this.destinations.clear();
    this.sessionUsers.clear();
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
    this.handles.clear();
    await Promise.allSettled([...this.outgoing.values()]);
    await this.companion?.pendingWrite;
  }
}

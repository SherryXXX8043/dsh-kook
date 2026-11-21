import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { KookTransport } from './transport.js';
import { KookBridge } from './bridge.js';
import { KookError, step, reportFailure } from './errors.js';
import { RouteStore } from './store.js';
import { CompanionStore, readKnowledge } from './companion.js';

export function configSnapshot(config = {}) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key,
    value && typeof value.get === 'function' ? value.get() : value]));
}

export function resolveToken(config = {}, env = process.env) {
  const values = configSnapshot(config);
  return (values.token ?? env[values.tokenEnv ?? 'KOOK_BOT_TOKEN'] ?? '').trim();
}

export function resolveConfig(config = {}, env = process.env) {
  const { token: _token, ...values } = configSnapshot(config);
  const csv = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const result = {
    tokenEnv: 'KOOK_BOT_TOKEN', workspace: env.KOOK_WORKSPACE ?? '',
    allowedUsers: csv(env.KOOK_ALLOWED_USERS), allowedChannels: csv(env.KOOK_ALLOWED_CHANNELS),
    allowPrivate: true, autoForwardChannels: false, pairingEnabled: false, ownerUserId: '', personality: '', memoryFile: '.dsh-kook/memories.json', memoryLimit: 8, memoryHalfLifeMonths: 6, knowledgeFile: '', knowledgeText: '', knowledgeName: '', knowledgeLimit: 5, commandPrefix: '/dsh', stateFile: '.dsh-kook/routes.json',
    ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
  };
  if (!result.workspace || !isAbsolute(result.workspace)) throw new Error('KOOK workspace must be an absolute path (config.workspace or KOOK_WORKSPACE)');
  for (const key of ['allowedUsers', 'allowedChannels']) {
    if (!Array.isArray(result[key]) || result[key].some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error(`${key} must contain quoted KOOK numeric IDs`);
  }
  if (!result.allowedUsers.length) throw new Error('Set allowedUsers or KOOK_ALLOWED_USERS before enabling KOOK');
  if (typeof result.commandPrefix !== 'string' || !result.commandPrefix.trim() || /\s/.test(result.commandPrefix)) throw new Error('commandPrefix must be a nonempty word');
  if (Boolean(result.provider) !== Boolean(result.model)) throw new Error('provider and model must be configured together');
  if (typeof result.stateFile !== 'string' || !result.stateFile) throw new Error('stateFile must be a nonempty path');
  if (typeof result.allowPrivate !== 'boolean' || typeof result.autoForwardChannels !== 'boolean' || typeof result.pairingEnabled !== 'boolean') throw new Error('allowPrivate, autoForwardChannels and pairingEnabled must be boolean');
   if (result.pairingEnabled && (!/^\d+$/.test(result.ownerUserId) || !result.ownerUserId)) throw new Error('ownerUserId must be set when pairing is enabled');
   if (!Number.isSafeInteger(result.memoryLimit) || result.memoryLimit < 0 || !Number.isSafeInteger(result.memoryHalfLifeMonths) || result.memoryHalfLifeMonths <= 0 || !Number.isSafeInteger(result.knowledgeLimit) || result.knowledgeLimit < 0) throw new Error('Invalid memory or knowledge limits');
  if (typeof result.knowledgeText !== 'string' || Buffer.byteLength(result.knowledgeText, 'utf8') > 1024 * 1024) throw new Error('Knowledge text must be UTF-8 text up to 1 MiB');
  result.workspace = resolve(result.workspace);
   result.stateFile = resolve(result.workspace, result.stateFile);
   result.memoryFile = resolve(result.workspace, result.memoryFile);
   result.knowledgeFile = result.knowledgeFile ? resolve(result.workspace, result.knowledgeFile) : '';
  return result;
}

/** Adapter for the public DSH 0.2.2-rc.5 Agent APIs. */
export function createAgentAdapter(ctx, config, signal) {
  async function options() {
    const presets = ctx.get('agentPresets');
    const requestedPreset = config.agentPreset?.trim() || undefined;
    if (requestedPreset && !presets) throw new KookError('PRESET_UNAVAILABLE');
    const presetId = presets ? (await step('PRESET_UNAVAILABLE', () => presets.resolve(requestedPreset))).id : undefined;
    const selection = await step('MODEL_UNAVAILABLE', () => config.provider ? { provider: config.provider, model: config.model } : ctx.agentDefaultModel.currentSelection());
    if (!selection?.provider || !selection?.model) throw new KookError('MODEL_UNAVAILABLE');
    return {
      ...(signal ? { signal } : {}),
      agentOptions: { provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) },
      meta: { cwd: config.workspace, ...(presetId ? { agentPreset: presetId } : {}) },
      setup: async (agentCtx, agent) => {
        if (agent.session.header.cwd !== config.workspace) throw new KookError('WORKSPACE_CHANGED');
        const storedPreset = presets ? presets.presetForSession(agent.session) ?? undefined : agent.session.header.agentPreset;
        if (storedPreset !== presetId) throw new KookError('PRESET_CHANGED');
        if (presets) await step('PRESET_UNAVAILABLE', () => presets.mount(agentCtx, presetId));
        // rc.5 resume preserves recorded selections; agentOptions alone is only a fallback.
        // This handle is still unpublished, so selecting here cannot race with a running turn.
        await step('MODEL_UNAVAILABLE', () => agent.model.select({
          provider: selection.provider, model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }));
      },
    };
  }
  async function attach(sessionId) {
    return step('WORKSPACE_ATTACH', async () => {
      const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
      if (!registry) throw new Error('Workspace registry unavailable');
      const workspace = await registry.create(config.workspace);
      await workspace.attachSession(sessionId);
    });
  }
  async function register(handle) {
    try { await attach(handle.agent.id); return handle; }
    catch (error) { await handle.dispose(); throw error; }
  }
  return {
    attach,
    async create(sessionId) { return register(await ctx.agents.create({ sessionId, ...await options() })); },
    async resume(resumeSessionId) {
      // Only our own handle can dispose a session. Never adopt someone else's live agent.
      if (ctx.agents.get(resumeSessionId)) throw new KookError('SESSION_OWNED');
      const { meta, ...opts } = await options();
      return register(await ctx.agents.resume({ resumeSessionId, ...opts }));
    },
  };
}

export default class KookPlugin {
  static inject = ['agents', 'agentDefaultModel', 'workspaceRegistry'];
  static Config = z.object({
    token: z.string().role('secret').description('KOOK Bot Token；留空并保存可停止连接。').volatile(),
    workspace: z.string().description('工作目录：已存在目录的绝对路径。').volatile(),
    allowedUsers: z.array(z.string().pattern(/^\d+$/)).default(undefined).description('允许使用的 KOOK 用户 ID。').volatile(),
    allowedChannels: z.array(z.string().pattern(/^\d+$/)).default(undefined).description('允许使用的频道 ID；空列表禁用频道。').volatile(),
    allowPrivate: z.boolean().description('允许白名单用户私聊机器人，默认开启。').volatile(),
    autoForwardChannels: z.boolean().description('自动把白名单频道中的普通消息转发到 DSH。').volatile(),
    pairingEnabled: z.boolean().description('陌生人必须经主人批准后才能使用。').volatile(),
    ownerUserId: z.string().description('主人 KOOK 用户 ID，用于接收配对请求。').volatile(),
    personality: z.string().description('机器人长期行为和说话风格设定。').volatile(),
    memoryFile: z.string().description('长期记忆文件路径。').volatile(),
    memoryLimit: z.number().step(1).min(0).max(50).description('每次提供给模型的记忆条数。').volatile(),
    memoryHalfLifeMonths: z.number().step(1).min(1).max(120).description('记忆权重减半所需月数。').volatile(),
    knowledgeText: z.string().description('从文件选择器导入的 UTF-8 知识文本快照。').volatile(),
    knowledgeName: z.string().description('已导入知识文件的名称，不保存客户端路径。').volatile(),
    knowledgeFile: z.string().description('知识库文本文件路径；用空行分隔条目。').volatile(),
    knowledgeLimit: z.number().step(1).min(0).max(20).description('每次提供给模型的知识条数。').volatile(),
    commandPrefix: z.string().pattern(/^\S+$/).description('频道命令前缀，默认 /dsh。').volatile(),
    stateFile: z.string().description('会话映射文件，相对工作目录解析。').volatile(),
    agentPreset: z.string().description('DSH Agent 预设，留空使用默认预设。').volatile(),
    provider: z.string().description('模型提供方，与模型名称一起填写。').volatile(),
    model: z.string().description('模型名称，留空使用 DSH 默认模型。').volatile(),
    tokenEnv: z.string().description('兼容环境变量的名称，默认 KOOK_BOT_TOKEN。').volatile(),
  });
  constructor(ctx, config = {}) {
    this.ctx = ctx; this.config = config;
    this.pending = Promise.resolve();
    this.closed = false;
  }
  async *[Service.init]() {
    this.logger = this.ctx.logger('kook');
    const unlisten = this.ctx.on('loader/volatile-update', () => this.reload());
    const startup = this.reload();
    yield async () => {
      this.closed = true;
      unlisten();
      this.lifetime?.abort();
      await this.pending;
      await this.runtime?.stop();
    };
    await startup;
  }
  reload() {
    if (this.closed) return this.pending;
    // Abort an in-flight agent setup immediately; serialize teardown and reconnect.
    this.lifetime?.abort();
    this.pending = this.pending.then(async () => {
      await this.runtime?.stop();
      this.runtime = undefined;
      if (this.closed) return;
      const values = configSnapshot(this.config);
      const token = resolveToken(values);
      if (!token) {
        this.logger.info('KOOK inactive: configure Bot Token in the plugin page.');
        return;
      }
      const config = resolveConfig(values);
      if (!(await stat(config.workspace)).isDirectory()) throw new Error('Invalid workspace');
      const store = new RouteStore(config.stateFile);
      const companion = new CompanionStore(config.memoryFile);
      await Promise.all([store.load(), companion.load()]);
      const knowledge = config.knowledgeText ? config.knowledgeText.split(/\r?\n\s*\r?\n/).map(text => text.trim()).filter(Boolean).slice(0, 1000) : await readKnowledge(config.knowledgeFile);
      if (this.closed) return;
      const lifetime = this.lifetime = new AbortController();
      const logger = this.logger;
      let bridge;
      const transport = new KookTransport({
        token, logger,
        onMessage: message => bridge.receive(message),
        onStatus: status => logger.info(`KOOK connection: ${typeof status === 'string' ? status : status.state ?? 'changed'}`),
      });
      const agents = createAgentAdapter(this.ctx, config, lifetime.signal);
      for (const sessionId of new Set(store.routes.values())) {
        if (this.closed || lifetime.signal.aborted) return;
        try { await agents.attach(sessionId); }
        catch (error) { reportFailure(logger, error); }
      }
      bridge = new KookBridge({ config, store, companion, knowledge, agents, send: (destination, text) => transport.send(destination, text), logger });
      const unlisten = this.ctx.on('session/event', (session, event) => bridge.onSessionEvent(session, event));
      this.runtime = { stop: async () => {
        unlisten();
        lifetime.abort();
        const stopping = bridge.stop();
        await transport.stop();
        await stopping;
      } };
      transport.start();
    }).catch((error) => {
      this.lastError = error instanceof Error ? error.message : 'configuration error';
      // Keep the form available to correct incomplete configuration; never log credentials.
      this.logger.warn('KOOK inactive: check workspace, user IDs, model selection and route file in the plugin configuration.');
    });
    return this.pending;
  }
}

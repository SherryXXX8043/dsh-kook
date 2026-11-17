import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
const FiberState = { ACTIVE: 2 };
import KookPlugin, { createAgentAdapter } from '../src/index.js';
import { KookBridge } from '../src/bridge.js';

function fixture({ storedPreset = 'standard', cwd = process.cwd(), attachError, owned = false } = {}) {
  const calls = { mounts: [], attachments: [], disposed: 0 };
  const presets = {
    resolve: async id => ({ id: id ?? 'standard' }),
    presetForSession: session => session.selectedPreset,
    mount: async (context, id) => { calls.mounts.push(id); },
  };
  const make = async options => {
    calls.options = options;
    const agent = { id: options.sessionId ?? options.resumeSessionId,
      session: { header: { cwd, agentPreset: 'stale-header' }, selectedPreset: storedPreset } };
    await options.setup({}, agent);
    return { agent, dispose: async () => { calls.disposed++; } };
  };
  const ctx = {
    get: name => { if (name === 'sessionProjections') throw new Error('Deprecated projection API accessed'); return ctx[name]; },
    agentPresets: presets,
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    agents: { create: make, resume: make, get: () => owned ? {} : undefined },
    workspaceRegistry: { create: async () => ({ attachSession: async id => {
      if (attachError) throw attachError;
      calls.attachments.push(id);
    } }) },
  };
  return { calls, adapter: createAgentAdapter(ctx, { workspace: process.cwd(), agentPreset: '' }) };
}

test('create uses current preset service, mounts default and attaches workspace', async () => {
  const { adapter, calls } = fixture();
  await adapter.create('new-session');
  assert.deepEqual(calls.options.meta, { cwd: process.cwd(), agentPreset: 'standard' });
  assert.deepEqual(calls.mounts, ['standard']);
  assert.deepEqual(calls.attachments, ['new-session']);
});

test('resume uses projected preset instead of stale header and omits creation metadata', async () => {
  const { adapter, calls } = fixture();
  await adapter.resume('old-session');
  assert.equal(calls.options.resumeSessionId, 'old-session');
  assert.equal('meta' in calls.options, false);
  assert.deepEqual(calls.attachments, ['old-session']);
});

for (const storedPreset of ['different', null]) {
  test(`resume refuses changed or removed preset: ${storedPreset}`, async () => {
    const { adapter, calls } = fixture({ storedPreset });
    await assert.rejects(adapter.resume('old-session'), error => error.code === 'PRESET_CHANGED');
    assert.deepEqual(calls.mounts, []);
    assert.deepEqual(calls.attachments, []);
  });
}

test('resume refuses a changed workspace', async () => {
  const { adapter } = fixture({ cwd: 'different-workspace' });
  await assert.rejects(adapter.resume('old-session'), error => error.code === 'WORKSPACE_CHANGED');
});

test('resume never takes ownership of another live agent', async () => {
  const { adapter, calls } = fixture({ owned: true });
  await assert.rejects(adapter.resume('owned-session'), error => error.code === 'SESSION_OWNED');
  assert.equal(calls.options, undefined);
});

test('failed workspace attachment disposes the newly acquired handle', async () => {
  const { adapter, calls } = fixture({ attachError: new Error('unavailable') });
  await assert.rejects(adapter.create('new-session'), error => error.code === 'WORKSPACE_ATTACH');
  assert.equal(calls.disposed, 1);
});

test('plugin activates and unloads under Cordis 4.1 with no token', async () => {
  const ctx = new Context();
  for (const service of KookPlugin.inject) ctx.provide(service, {});
  const plugin = ctx.plugin(KookPlugin, { token: '' });
  await plugin;
  assert.equal(plugin.state, FiberState.ACTIVE);
  await plugin.dispose();
  assert.notEqual(plugin.state, FiberState.ACTIVE);
});

test('consecutive KOOK prompts submit distinct identified user messages', async () => {
  const submitted = [];
  const routes = new Map();
  const bridge = new KookBridge({
    config: { allowedUsers: ['1'], allowedChannels: [], allowPrivate: true, commandPrefix: '/dsh', memoryLimit: 0, knowledgeLimit: 0 },
    store: { get: key => routes.get(key), set: async (key, value) => routes.set(key, value) },
    agents: { create: async id => ({ agent: { id, followup: message => submitted.push(message) }, dispose: async () => {} }) },
    send: async () => {},
  });
  for (const id of ['first', 'second']) await bridge.receive({ id, kind: 'private', targetId: '1', authorId: '1', text: id });
  assert.equal(submitted.length, 2);
  assert.notEqual(submitted[0].id, submitted[1].id);
  for (const message of submitted) {
    assert.equal(message.role, 'user');
    assert.deepEqual(message.source, { kind: 'user' });
    assert.ok(Object.isFrozen(message));
  }
  await bridge.stop();
});

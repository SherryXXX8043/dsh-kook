import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentModel } from '@deepseek-ai/dsh-agent';
import { createAgentAdapter } from '../src/index.js';

// Runs against the actual installed rc.5 AgentModel via validation/runtime-hooks.mjs.
// No model provider, live Session, user profile or KOOK token is used.
for (const method of ['create', 'resume']) {
  test(`installed rc.5 AgentModel: ${method} replaces recorded model and retains default effort`, async () => {
    const changes = [];
    const state = { pending: null, lastUsed: { provider: 'old-provider', model: 'old-model' } };
    const session = { header: { cwd: process.cwd() }, append(type, data) {
      assert.equal(type, 'model/selection');
      state.pending = data;
      changes.push(data);
    } };
    const agent = { id: 'local-rc5-validation', session };
    agent.model = new AgentModel(() => state, session, { provider: 'fallback', model: 'fallback-model' });
    const make = async options => { await options.setup({}, agent); return { agent, dispose: async () => {} }; };
    const ctx = {
      get: key => ctx[key],
      agentDefaultModel: { currentSelection: () => ({ provider: 'selected', model: 'selected-model', reasoningEffort: 'high' }) },
      agents: { get: () => undefined, create: make, resume: make },
      workspaceRegistry: { create: async () => ({ attachSession: async () => {} }) },
    };
    const adapter = createAgentAdapter(ctx, { workspace: process.cwd() });
    await adapter[method]('local-rc5-validation');
    assert.deepEqual(agent.model.current(), { provider: 'selected', model: 'selected-model', reasoningEffort: 'high' });
    assert.equal(changes.length, 1);
    await adapter[method]('local-rc5-validation');
    assert.equal(changes.length, 1, 'same selection must not create duplicate model events');
  });
}

for (const selected of [
  { provider: 'same', model: 'same-model', reasoningEffort: 'low' },
  { provider: 'same', model: 'same-model' },
]) {
  test(`installed rc.5 AgentModel: effort becomes ${selected.reasoningEffort ?? 'adapter default'}`, () => {
    const state = { pending: null, lastUsed: { provider: 'same', model: 'same-model', reasoningEffort: 'high' } };
    const events = [];
    const model = new AgentModel(() => state, { append(type, data) {
      events.push({ type, data }); state.pending = data;
    } }, {});
    model.select(selected);
    assert.deepEqual(model.current(), selected);
    assert.equal(events.length, 1);
    model.select(selected);
    assert.equal(events.length, 1);
  });
}

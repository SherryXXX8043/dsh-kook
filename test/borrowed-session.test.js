import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentAdapter } from '../src/index.js';
import { KookBridge } from '../src/bridge.js';
import { createImageTool } from '../src/image-tool.js';

const workspace = process.cwd();
const id = 'session-ui-owned';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function adapterFixture({ live = true, config = {}, attach, resolvePreset, resume, header = {}, agentPatch = {} } = {}) {
  const calls = { select: 0, mount: 0, attach: [], create: 0, resume: 0, dispose: 0, followup: [], cancel: 0 };
  const agent = { id, session: { header: { cwd: workspace, agentPreset: 'standard', ...header } },
    model: { current: () => ({ provider: 'ui-provider', model: 'ui-model' }), select: () => { calls.select++; } },
    followup: async message => calls.followup.push(message), cancel: () => { calls.cancel++; }, ...agentPatch };
  const controller = new AbortController();
  let current = live ? agent : undefined;
  const ctx = {
    get: key => ctx[key],
    agentPresets: { resolve: async requested => { await resolvePreset?.(); return { id: requested ?? 'standard' }; },
      presetForSession: session => session.header.agentPreset, mount: async () => { calls.mount++; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'configured-provider', model: 'configured-model' }) },
    workspaceRegistry: { create: async path => { assert.equal(path, workspace); return { attachSession: async value => { calls.attach.push(value); await attach?.(); } }; } },
    agents: { get: () => current,
      create: async () => { calls.create++; throw new Error('unexpected create'); },
      resume: async options => { calls.resume++; if (resume) return resume(options, agent);
        await options.setup({}, agent); return { agent, dispose: async () => { calls.dispose++; } }; } },
  };
  const adapter = createAgentAdapter(ctx, { workspace, agentPreset: '', ...config }, controller.signal);
  return { adapter, agent, ctx, calls, controller, setCurrent: next => { current = next; } };
}

for (const agentPreset of ['', 'standard']) test(`borrowing ${agentPreset || 'default'} UI session preserves model and ownership`, async () => {
  const f = adapterFixture({ config: { agentPreset } });
  const originalModel = f.agent.model.current();
  const handle = await f.adapter.resume(id);
  assert.equal(handle.agent, f.agent); assert.equal(handle.borrowed, true); assert.equal(handle.isCurrent(), true);
  assert.deepEqual(f.calls.attach, [id]); assert.equal(f.calls.resume, 0); assert.equal(f.calls.create, 0);
  assert.equal(f.calls.select, 0); assert.equal(f.calls.mount, 0);
  assert.deepEqual(f.agent.model.current(), originalModel);
  await handle.dispose(); await handle.dispose();
  assert.equal(f.calls.dispose, 0); assert.equal(f.calls.cancel, 0);
  f.setCurrent(undefined); assert.equal(handle.isCurrent(), false);
});

test('borrow refuses mismatched workspace, preset, subagent and malformed identity without modifying external Agent', async () => {
  for (const options of [{ header: { cwd: 'other-workspace' } }, { header: { agentPreset: 'other' } },
    { header: { origin: 'subagent' } }, { agentPatch: { id: 'wrong-id' } }, { agentPatch: { session: {} } }]) {
    const f = adapterFixture(options);
    await assert.rejects(f.adapter.resume(id));
    assert.equal(f.calls.attach.length, 0); assert.equal(f.calls.select, 0); assert.equal(f.calls.mount, 0);
    assert.equal(f.calls.resume, 0); assert.equal(f.calls.dispose, 0);
  }
});

test('borrow attach failure never disposes UI-owned Agent', async () => {
  const f = adapterFixture({ attach: async () => { throw new Error('private attachment failure'); } });
  await assert.rejects(f.adapter.resume(id), error => error.code === 'WORKSPACE_ATTACH');
  assert.equal(f.calls.dispose, 0); assert.equal(f.calls.select, 0); assert.equal(f.calls.mount, 0);
});

test('borrow rechecks identity after asynchronous attachment', async () => {
  const gate = deferred(), started = deferred();
  const f = adapterFixture({ attach: async () => { started.resolve(); await gate.promise; } });
  const borrowing = f.adapter.resume(id); await started.promise;
  f.setCurrent({ ...f.agent }); gate.resolve();
  await assert.rejects(borrowing, error => error.code === 'SESSION_OWNED');
  assert.equal(f.calls.dispose, 0); assert.equal(f.calls.resume, 0);
});

test('pre-aborted and attachment-time abort reject borrowed acquisition without external cleanup', async () => {
  const first = adapterFixture(); first.controller.abort();
  await assert.rejects(first.adapter.resume(id)); assert.equal(first.calls.attach.length, 0);
  const gate = deferred(), started = deferred();
  const f = adapterFixture({ attach: async () => { started.resolve(); await gate.promise; } });
  const borrowing = f.adapter.resume(id); await started.promise; f.controller.abort(); gate.resolve();
  await assert.rejects(borrowing); assert.equal(f.calls.dispose, 0); assert.equal(f.calls.select, 0);
});

test('borrowed handle expires when plugin signal aborts even while UI identity remains', async () => {
  const f = adapterFixture(); const handle = await f.adapter.resume(id);
  f.controller.abort(); assert.equal(handle.isCurrent(), false); await handle.dispose();
  assert.equal(f.calls.dispose, 0); assert.equal(f.calls.cancel, 0);
});

test('live Agent appearing during options await is borrowed rather than resumed', async () => {
  const gate = deferred(), started = deferred(); let resolution = 0;
  const f = adapterFixture({ live: false, resolvePreset: async () => { if (++resolution === 1) { started.resolve(); await gate.promise; } } });
  const pending = f.adapter.resume(id); await started.promise; f.setCurrent(f.agent); gate.resolve();
  const handle = await pending;
  assert.equal(handle.agent, f.agent); assert.equal(handle.borrowed, true); assert.equal(f.calls.resume, 0);
  assert.equal(f.calls.select, 0); assert.equal(f.calls.mount, 0);
});

test('failed cold resume racing with UI acquisition borrows the newly live Agent', async () => {
  let f;
  f = adapterFixture({ live: false, resume: async () => { f.setCurrent(f.agent); throw Object.assign(new Error('Agent ownership race'), { name: 'SessionAlreadyOwnedError' }); } });
  const handle = await f.adapter.resume(id);
  assert.equal(handle.agent, f.agent); assert.equal(handle.borrowed, true); assert.equal(f.calls.resume, 1);
  assert.equal(f.calls.select, 0); assert.equal(f.calls.mount, 0); assert.equal(f.calls.dispose, 0);
});

test('nonownership cold resume errors are never swallowed even if a live Agent appears', async () => {
  let f;
  const failure = new Error('Storage failure must propagate');
  f = adapterFixture({ live: false, resume: async () => { f.setCurrent(f.agent); throw failure; } });
  await assert.rejects(f.adapter.resume(id), error => error === failure);
  assert.equal(f.calls.attach.length, 0); assert.equal(f.calls.dispose, 0);
});

test('cold resume retains owned setup model selection mount and dispose behavior', async () => {
  const f = adapterFixture({ live: false }); const handle = await f.adapter.resume(id);
  assert.equal(handle.borrowed, undefined); assert.equal(f.calls.resume, 1);
  assert.equal(f.calls.select, 1); assert.equal(f.calls.mount, 1); assert.deepEqual(f.calls.attach, [id]);
  await handle.dispose(); assert.equal(f.calls.dispose, 1);
});

function bridgeFixture(t, f, { companion, resume } = {}) {
  const key = JSON.stringify(['private', '1', '1']);
  const routes = new Map([[key, id]]), resumed = [], sends = [];
  const bridge = new KookBridge({ config: { allowedUsers: ['1'], allowedChannels: [], allowPrivate: true,
    commandPrefix: '/nemo', memoryLimit: 0, knowledgeLimit: 0 }, companion,
    store: { get: value => routes.get(value), set: async (value, sessionId) => sessionId === undefined ? routes.delete(value) : routes.set(value, sessionId) },
    agents: { resume: async value => { resumed.push(value); return resume ? resume(value) : f.adapter.resume(value); },
      create: async () => { throw new Error('Existing route must never fork'); } },
    send: async (_destination, text) => sends.push(text), logger: { warn() {} } });
  let seq = 0;
  const receive = text => bridge.receive({ id: `borrow-message-${++seq}`, kind: 'private', targetId: '1', authorId: '1', text });
  t.after(() => bridge.stop());
  return { bridge, key, routes, resumed, sends, receive };
}

test('stale borrowed route reacquires stored session id and cleans old destinations without forking', async t => {
  const f = adapterFixture(); const b = bridgeFixture(t, f);
  await b.receive('first'); const firstHandle = b.bridge.handles.get(b.key);
  const nextMessages = [];
  const replacement = { ...f.agent, session: { header: { ...f.agent.session.header } }, followup: async message => nextMessages.push(message) };
  f.setCurrent(replacement);
  assert.equal(b.bridge.currentHandle(b.key), undefined);
  assert.equal(b.bridge.destinations.has(id), false); assert.equal(b.bridge.sessionUsers.has(id), false);
  await b.receive('second');
  assert.deepEqual(b.resumed, [id, id]); assert.equal(b.routes.get(b.key), id);
  assert.equal(firstHandle.isCurrent(), false); assert.equal(nextMessages.length, 1); assert.equal(f.calls.followup.length, 1);
  assert.equal(b.bridge.handles.get(b.key).agent, replacement); assert.equal(f.calls.dispose, 0);
});

test('duplicate stored session id on another user route cannot overwrite the first destination', async t => {
  const f = adapterFixture(); const b = bridgeFixture(t, f); await b.receive('first');
  b.bridge.config.allowedUsers.push('2');
  const secondKey = JSON.stringify(['private', '2', '2']); b.routes.set(secondKey, id);
  await b.bridge.receive({ id: 'other-route', kind: 'private', targetId: '2', authorId: '2', text: 'must not cross users' });
  assert.equal(f.calls.followup.length, 1);
  assert.equal(b.bridge.handles.has(secondKey), false);
  assert.deepEqual(b.bridge.destinations.get(id), { kind: 'private', targetId: '1' });
  assert.deepEqual(b.resumed, [id]);
  assert.equal(f.calls.dispose, 0);
});

test('borrowed event routing rejects a replaced Session object and stale identity', async t => {
  const f = adapterFixture(); const b = bridgeFixture(t, f); await b.receive('first');
  const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'external response' }] } } };
  const actualSession = f.agent.session; actualSession.id = id;
  b.bridge.onSessionEvent({ id, header: actualSession.header }, event);
  await Promise.all(b.bridge.outgoing.values()); assert.equal(b.sends.length, 0);
  b.bridge.onSessionEvent(actualSession, event);
  await Promise.all(b.bridge.outgoing.values()); assert.deepEqual(b.sends, ['external response']);
  f.setCurrent(undefined); b.bridge.onSessionEvent(actualSession, event);
  await Promise.all(b.bridge.outgoing.values()); assert.equal(b.sends.length, 1);
});

test('new clears route and plugin shutdown releases only borrowed handles without disposing UI Agent', async t => {
  const f = adapterFixture(); const b = bridgeFixture(t, f);
  await b.receive('first'); await b.receive('/new');
  assert.equal(b.routes.has(b.key), false); assert.equal(b.bridge.handles.size, 0);
  assert.equal(f.calls.dispose, 0); assert.equal(f.ctx.agents.get(id), f.agent);
  b.routes.set(b.key, id); await b.receive('again'); await b.bridge.stop();
  assert.equal(f.calls.dispose, 0); assert.equal(f.calls.cancel, 0); assert.equal(f.ctx.agents.get(id), f.agent);
});

test('borrowed current UI Agent may receive stop but is never disposed by the bridge', async t => {
  const f = adapterFixture(); const b = bridgeFixture(t, f);
  await b.receive('first'); await b.receive('/stop');
  assert.equal(f.calls.cancel, 1); assert.equal(f.calls.dispose, 0); assert.equal(f.ctx.agents.get(id), f.agent);
});

test('borrow becoming stale during memory write is not submitted to old Agent', async t => {
  const gate = deferred(), started = deferred();
  const f = adapterFixture(); const b = bridgeFixture(t, f, { companion: { recall: async () => [], remember: async () => { started.resolve(); await gate.promise; } } });
  const pending = b.receive('must not submit'); await started.promise;
  f.setCurrent({ ...f.agent }); gate.resolve(); await pending;
  assert.equal(f.calls.followup.length, 0); assert.equal(f.calls.dispose, 0);
  assert.ok(b.sends.some(text => text.includes('SESSION_OWNED')));
});

test('image tool rejects stale borrowed handle before reading or publishing', async t => {
  const f = adapterFixture(); const b = bridgeFixture(t, f); await b.receive('first'); f.setCurrent(undefined);
  let reads = 0, sends = 0;
  const tool = createImageTool({ bridge: b.bridge, images: { readLocal: async () => { reads++; } },
    transport: { sendImage: async () => { sends++; } }, logger: { warn() {} } });
  await assert.rejects(tool.execute({ path: 'picture.png' }, { agent: f.agent, signal: new AbortController().signal }), error => error.code === 'IMAGE_ROUTE');
  assert.equal(reads, 0); assert.equal(sends, 0);
});

test('image tool rechecks borrowed identity after reading and before queued delivery', async t => {
  const f = adapterFixture(); const b = bridgeFixture(t, f); await b.receive('first');
  let sends = 0;
  const tool = createImageTool({ bridge: b.bridge, images: { readLocal: async () => { f.setCurrent(undefined); return { data: new Uint8Array(), mediaType: 'image/png', name: 'test.png' }; } },
    transport: { sendImage: async () => { sends++; } }, logger: { warn() {} } });
  const result = await tool.execute({ path: 'picture.png' }, { agent: f.agent, signal: new AbortController().signal });
  assert.equal(result.status, 'unconfirmed'); assert.equal(sends, 0);
});

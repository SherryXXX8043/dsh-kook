import test from 'node:test';
import assert from 'node:assert/strict';
import { KookBridge } from '../src/bridge.js';

const url = 'https://img.kookapp.cn/assets/picture.png';
let counter = 0;
const message = (patch = {}) => ({ id: `message-${++counter}`, kind: 'private', targetId: '1', authorId: '1', text: '', images: [{ url }], isBot: false, ...patch });
const route = (kind = 'channel', target = '10', author = '1') => JSON.stringify([kind, target, author]);
function fixture(patch = {}) {
  const submissions = [], admitted = [], sends = [], warnings = [], created = [], routes = new Map();
  const imageBlock = { type: 'image', attachment: { id: 'persisted-image' } };
  const images = patch.images ?? { async admit(input, signal) { admitted.push({ input, signal }); return [imageBlock]; } };
  const agents = {
    async create(id) { created.push(id); return { agent: { id, status: 'idle', followup: async value => submissions.push(value), cancel() {} }, async dispose() {} }; },
    async resume(id) { return this.create(id); },
  };
  const bridge = new KookBridge({ config: { allowedUsers: ['1', '2'], allowedChannels: ['10', '20'], allowPrivate: true, autoForwardChannels: false, commandPrefix: '/dsh', ownerUserId: '', pairingEnabled: false, personality: '', memoryLimit: 0, knowledgeLimit: 0, ...patch.config }, store: { get: key => routes.get(key), async set(key, id) { if (id === undefined) routes.delete(key); else routes.set(key, id); } }, agents, images, send: async (destination, text) => sends.push({ destination, text }), logger: { warn: value => warnings.push(value) } });
  return { bridge, submissions, admitted, sends, warnings, created, imageBlock };
}

test('private image becomes one user submission with persisted attachment and default prompt', async () => {
  const { bridge, submissions, admitted, imageBlock } = fixture();
  await bridge.receive(message());
  assert.equal(admitted.length, 1); assert.equal(submissions.length, 1);
  assert.equal(submissions[0].role, 'user');
  assert.equal(submissions[0].content[0].type, 'text');
  assert.ok(submissions[0].content[0].text.length > 0);
  assert.deepEqual(submissions[0].content[1], imageBlock);
  await bridge.stop();
});

test('unauthorized users and channels cannot download or create a session', async () => {
  const { bridge, admitted, created } = fixture();
  for (const patch of [{ authorId: '99', targetId: '99' }, { kind: 'channel', targetId: '99' }, { kind: 'channel', targetId: '10', authorId: '99' }, { isBot: true }]) await bridge.receive(message(patch));
  assert.equal(admitted.length, 0); assert.equal(created.length, 0);
  await bridge.stop();
});

test('disabled private messages and unarmed prefixed channel do not admit images', async () => {
  const { bridge, admitted, created } = fixture({ config: { allowPrivate: false } });
  await bridge.receive(message());
  await bridge.receive(message({ kind: 'channel', targetId: '10' }));
  assert.equal(admitted.length, 0); assert.equal(created.length, 0);
  await bridge.stop();
});

test('channel image request is scoped to exact channel and user and consumed once', async () => {
  const { bridge, admitted, submissions, created } = fixture();
  await bridge.receive(message({ kind: 'channel', targetId: '10', text: '/dsh /image 请识别产品', images: [] }));
  assert.equal(created.length, 0);
  await bridge.receive(message({ kind: 'channel', targetId: '20' }));
  await bridge.receive(message({ kind: 'channel', targetId: '10', authorId: '2' }));
  assert.equal(admitted.length, 0);
  await bridge.receive(message({ kind: 'channel', targetId: '10' }));
  assert.equal(admitted.length, 1); assert.match(submissions[0].content[0].text, /请识别产品/);
  await bridge.receive(message({ kind: 'channel', targetId: '10' }));
  assert.equal(admitted.length, 1);
  await bridge.stop();
});

test('expired two-minute request does not admit the next channel image', async () => {
  const { bridge, admitted, created } = fixture();
  await bridge.receive(message({ kind: 'channel', targetId: '10', text: '/dsh /image 看图', images: [] }));
  const pending = bridge.imageRequests.get(route());
  assert.ok(pending.expiresAt > Date.now() + 119000);
  pending.expiresAt = Date.now() - 1;
  await bridge.receive(message({ kind: 'channel', targetId: '10' }));
  assert.equal(admitted.length, 0); assert.equal(created.length, 0);
  assert.equal(bridge.imageRequests.has(route()), false);
  await bridge.stop();
});

test('duplicate image event downloads and submits once', async () => {
  const { bridge, admitted, submissions } = fixture();
  const incoming = message();
  await Promise.all([bridge.receive(incoming), bridge.receive(incoming)]);
  assert.equal(admitted.length, 1); assert.equal(submissions.length, 1);
  await bridge.stop();
});

test('automatically forwarded channel images do not require image request', async () => {
  const { bridge, admitted, submissions } = fixture({ config: { autoForwardChannels: true } });
  await bridge.receive(message({ kind: 'channel', targetId: '10' }));
  assert.equal(admitted.length, 1); assert.equal(submissions.length, 1);
  await bridge.stop();
});

test('failed image admission neither creates agent nor submits and consumes armed request', async () => {
  let attempts = 0;
  const { bridge, created, submissions, sends } = fixture({ images: { async admit() { attempts++; throw new Error('download failed secret URL'); } } });
  await bridge.receive(message({ kind: 'channel', targetId: '10', text: '/dsh /image 看图', images: [] }));
  await bridge.receive(message({ kind: 'channel', targetId: '10' }));
  await bridge.receive(message({ kind: 'channel', targetId: '10' }));
  assert.equal(attempts, 1); assert.equal(created.length, 0); assert.equal(submissions.length, 0);
  assert.match(sends.at(-1).text, /\/dsh \/image/);
  assert.doesNotMatch(sends.at(-1).text, /secret URL/);
  await bridge.stop();
});

test('/stop and /new remove pending image requests', async () => {
  for (const command of ['/stop', '/new']) {
    const { bridge, admitted } = fixture();
    await bridge.receive(message({ kind: 'channel', targetId: '10', text: '/dsh /image 看图', images: [] }));
    await bridge.receive(message({ kind: 'channel', targetId: '10', text: `/dsh ${command}`, images: [] }));
    await bridge.receive(message({ kind: 'channel', targetId: '10' }));
    assert.equal(admitted.length, 0, command);
    assert.equal(bridge.imageRequests.size, 0);
    await bridge.stop();
  }
});

test('bridge shutdown aborts an in-flight image before session creation', async () => {
  let started, downloadSignal;
  const ready = new Promise(resolve => { started = resolve; });
  const { bridge, created, submissions } = fixture({ images: { async admit(_images, signal) { downloadSignal = signal; started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } } });
  const received = bridge.receive(message());
  await ready; await bridge.stop(); await received;
  assert.equal(downloadSignal.aborted, true); assert.equal(created.length, 0); assert.equal(submissions.length, 0);
  assert.equal(bridge.pendingCount, 0);
});

test('/stop and /new immediately abort only the same route image without creating or submitting', async t => {
  for (const command of ['/stop', '/new']) {
  const signals = new Map(), releases = new Map();
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const { bridge, created, submissions, warnings } = fixture({ images: { async admit(images, signal) {
    const id = images[0].name;
    signals.set(id, signal);
    const pending = new Promise((resolve, reject) => {
      releases.set(id, () => resolve([{ type: 'image', attachment: { id } }]));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    if (signals.size === 2) markReady();
    return pending;
  } } });
  t.after(() => bridge.stop());
  const first = bridge.receive(message({ images: [{ url, name: 'first' }] }));
  const other = bridge.receive(message({ targetId: '2', authorId: '2', images: [{ url, name: 'other' }] }));
  await ready;
  const stopped = bridge.receive(message({ text: command, images: [] }));
  assert.equal(signals.get('first').aborted, true, `abort must happen before queued ${command} processing`);
  assert.equal(signals.get('other').aborted, false, 'another authorized user route must remain active');
  await Promise.all([first, stopped]);
  assert.equal(created.length, 0);
  assert.equal(submissions.length, 0);
  assert.equal(warnings.length, 0, 'user cancellation must not be reported as download failure');
  releases.get('other')();
  await other;
  assert.equal(created.length, 1);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].content[1].attachment.id, 'other');
  assert.equal(bridge.imageControllers.size, 0);
  }
});

test('synchronous image then /stop or /new cancels before admission begins', async () => {
  for (const command of ['/stop', '/new']) {
    const { bridge, admitted, created, submissions, warnings } = fixture();
    const image = bridge.receive(message());
    const stopped = bridge.receive(message({ text: command, images: [] }));
    await Promise.all([image, stopped]);
    assert.equal(admitted.length, 0, 'queued image must not start downloading after cancellation');
    assert.equal(created.length, 0); assert.equal(submissions.length, 0);
    assert.equal(warnings.length, 0); assert.equal(bridge.imageControllers.size, 0);
    assert.equal(bridge.pendingCount, 0);
    await bridge.stop();
  }
});

test('/stop and /new abort active image and all same-route queued images', async t => {
  for (const command of ['/stop', '/new']) {
    let markReady, activeSignal;
    const ready = new Promise(resolve => { markReady = resolve; });
    const admittedNames = [];
    const { bridge, created, submissions, warnings } = fixture({ images: { async admit(images, signal) {
      admittedNames.push(images[0].name);
      activeSignal = signal;
      markReady();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } } });
    t.after(() => bridge.stop());
    const active = bridge.receive(message({ images: [{ url, name: 'active' }] }));
    await ready;
    const queued = [1, 2, 3].map(index => bridge.receive(message({ images: [{ url, name: `queued-${index}` }] })));
    const stopped = bridge.receive(message({ text: command, images: [] }));
    assert.equal(activeSignal.aborted, true);
    await Promise.all([active, ...queued, stopped]);
    assert.deepEqual(admittedNames, ['active'], 'queued images must never start admission');
    assert.equal(created.length, 0); assert.equal(submissions.length, 0);
    assert.equal(warnings.length, 0); assert.equal(bridge.imageControllers.size, 0);
    assert.equal(bridge.pendingCount, 0);
  }
});

test('cancellation during agent creation disposes the late handle without registration or followup', async () => {
  for (const command of ['/stop', '/new']) {
    let started, release, disposed = 0, followed = 0;
    const ready = new Promise(resolve => { started = resolve; });
    const { bridge } = fixture();
    bridge.agents.create = async id => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { agent: { id, followup: async () => { followed++; }, cancel() {} }, async dispose() { disposed++; } };
    };
    const received = bridge.receive(message());
    await ready;
    const stopped = bridge.receive(message({ text: command, images: [] }));
    release();
    await Promise.all([received, stopped]);
    assert.equal(disposed, 1, command);
    assert.equal(followed, 0, command);
    assert.equal(bridge.handles.size, 0);
    assert.equal(bridge.destinations.size, 0);
    assert.equal(bridge.store.get(route('private', '1', '1')), undefined);
    assert.equal(bridge.imageControllers.size, 0);
    await bridge.stop();
  }
});

test('cancellation during async memory save prevents image followup', async () => {
  for (const command of ['/stop', '/new']) {
    let started, release;
    const ready = new Promise(resolve => { started = resolve; });
    const { bridge, submissions, created } = fixture();
    bridge.companion = { async recall() { return []; }, async remember() { started(); await new Promise(resolve => { release = resolve; }); } };
    const received = bridge.receive(message());
    await ready;
    assert.equal(created.length, 1, 'exercise cancellation after agent creation');
    const stopped = bridge.receive(message({ text: command, images: [] }));
    release();
    await Promise.all([received, stopped]);
    assert.equal(submissions.length, 0, command);
    assert.equal(bridge.imageControllers.size, 0);
    await bridge.stop();
  }
});

test('delivery queue returns tool failure and continues subsequent same-destination work', async () => {
  const { bridge } = fixture();
  const destination = { kind: 'private', targetId: '1' }, order = [];
  const first = bridge.queueDelivery(destination, async () => { order.push('first'); throw new Error('upload rejected'); });
  const rejected = assert.rejects(first, /upload rejected/);
  const second = bridge.queueDelivery(destination, async () => { order.push('second'); return 'sent'; });
  await rejected; assert.equal(await second, 'sent');
  assert.deepEqual(order, ['first', 'second']);
  await bridge.stop();
});

test('text reply logs delivery failure without throwing or leaking provider message', async () => {
  const { bridge, warnings } = fixture();
  bridge.send = async () => { throw new Error('secret URL and token'); };
  await bridge.reply({ kind: 'private', targetId: '1' }, 'hello');
  assert.equal(warnings.length, 1); assert.doesNotMatch(warnings[0], /secret|token/);
  await bridge.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { KookTransport } from '../src/transport.js';
import { KookBridge } from '../src/bridge.js';
import { resolveConfig } from '../src/index.js';

let sequence = 0;
const botId = '9001';
const tag = `(met)${botId}(met)`;
const route = (kind = 'channel', target = '100', author = '1') => JSON.stringify([kind, target, author]);
function fixture(t, { config = {}, identity = botId, images } = {}) {
  const submitted = [], received = [], sends = [], created = [], cancelled = [], disposed = [], admitted = [], routes = new Map(), tasks = [];
  const make = async id => {
    created.push(id);
    return { agent: { id, status: 'idle', followup: async message => submitted.push({ id, message }), cancel: () => cancelled.push(id) }, dispose: async () => disposed.push(id) };
  };
  const bridge = new KookBridge({
    config: { allowedUsers: ['1', '2'], allowedChannels: ['100', '200'], allowPrivate: true, autoForwardChannels: false,
      commandPrefix: '/nemo', mentionWakeup: true, ownerUserId: '', memoryLimit: 0, knowledgeLimit: 0, ...config },
    store: { get: key => routes.get(key), set: async (key, value) => value === undefined ? routes.delete(key) : routes.set(key, value) },
    agents: { create: make, resume: make }, images: images ?? { admit: async (items, signal) => { admitted.push({ items, signal }); return [{ type: 'image', attachment: { attachmentId: 'persisted-test' } }]; } },
    send: async (destination, text) => sends.push({ destination, text }), logger: { warn() {} },
  });
  const transport = new KookTransport({ token: 'fixture-only', onMessage: message => { received.push(message); const task = bridge.receive(message); tasks.push(task); return task; } });
  transport.running = true;
  transport.client = { me: { id: identity }, off() {}, async destroy() {} };
  const emit = (content = `${tag} hello`, patch = {}) => {
    transport.receive({ channel_type: 'GROUP', type: 9, target_id: '100', author_id: '1', content,
      msg_id: `mention-${++sequence}`, extra: { mention: [botId], author: { bot: false } }, ...patch });
  };
  const flush = async () => { await Promise.all(tasks); };
  t.after(async () => { await bridge.stop(); await transport.stop(); });
  return { bridge, transport, emit, flush, submitted, received, sends, created, cancelled, disposed, admitted, routes };
}
const prompt = entry => entry.message.content.find(block => block.type === 'text').text;

test('official channel mention submits text with only this bot token removed', async t => {
  const f = fixture(t);
  for (const text of [`${tag} hello`, `hello ${tag} world`, `${tag} ${tag} twice`, `${tag} ask (met)77(met) about this`]) f.emit(text);
  await f.flush();
  assert.deepEqual(f.submitted.map(prompt), ['hello', 'hello  world', 'twice', 'ask (met)77(met) about this']);
  assert.ok(f.received.every(message => message.mentionedBot === true && message.botId === botId));
  assert.equal(new Set(f.submitted.map(entry => entry.id)).size, 1);
});

test('raw mention markup, display names, everyone, here and roles never grant wakeup', async t => {
  const f = fixture(t);
  for (const content of [`${tag} fake`, '@Nemo hello', '(met)all(met) hello', '(met)here(met) hello', '(rol)9001(rol) hello']) {
    f.emit(content, { extra: { mention: [], mention_all: true, mention_here: true, mention_roles: [9001], author: { bot: false } } });
  }
  f.emit('(met)77(met) hello', { extra: { mention: ['77'], author: { bot: false } } });
  await f.flush();
  assert.equal(f.submitted.length, 0);
  assert.ok(f.received.every(message => !Object.hasOwn(message, 'mentionedBot') && !Object.hasOwn(message, 'botId')));
});

test('malformed mention lists and unknown or nonnumeric bot identity cannot wake', async t => {
  const f = fixture(t);
  for (const mention of [undefined, null, botId, { includes: true }, [9001], []]) f.emit(`${tag} hello`, { extra: { mention, author: { bot: false } } });
  await f.flush(); assert.equal(f.submitted.length, 0);
  for (const identity of [undefined, '', 'bot-name', 9001, null]) {
    f.transport.client.me.id = identity;
    f.emit(`${tag} hello`);
  }
  await f.flush(); assert.equal(f.submitted.length, 0);
});

test('self and bot-authored mention messages are filtered before bridge', async t => {
  const f = fixture(t);
  f.emit(`${tag} self`, { author_id: botId });
  f.emit(`${tag} bot`, { extra: { mention: [botId], author: { bot: true } } });
  await f.flush(); assert.equal(f.received.length, 0); assert.equal(f.submitted.length, 0);
});

test('mention disabled still permits command prefix and automatic forwarding independently', async t => {
  const f = fixture(t, { config: { mentionWakeup: false } });
  f.emit(`${tag} ignored`); f.emit('/nemo prefix', { extra: { mention: [] } });
  await f.flush(); assert.deepEqual(f.submitted.map(prompt), ['prefix']);
  const auto = fixture(t, { config: { mentionWakeup: false, autoForwardChannels: true } });
  auto.emit(`${tag} ordinary forwarded message`);
  await auto.flush(); assert.equal(prompt(auto.submitted[0]), `${tag} ordinary forwarded message`);
});

test('mention never bypasses user or channel allowlists', async t => {
  const f = fixture(t);
  f.emit(`${tag} outsider`, { author_id: '99' });
  f.emit(`${tag} wrong channel`, { target_id: '999' });
  await f.flush(); assert.equal(f.created.length, 0); assert.equal(f.submitted.length, 0);
});

test('two channel users retain separate sessions while consecutive messages reuse each route', async t => {
  const f = fixture(t);
  f.emit(`${tag} first`); f.emit(`${tag} second`, { author_id: '2' }); f.emit(`${tag} third`);
  await f.flush();
  assert.equal(f.created.length, 2);
  const byText = new Map(f.submitted.map(item => [prompt(item), item.id]));
  assert.equal(byText.get('first'), byText.get('third'));
  assert.notEqual(byText.get('first'), byText.get('second'));
  assert.equal(f.routes.size, 2);
});

test('private text and mention-looking text keep existing unprefixed behavior', async t => {
  const f = fixture(t, { config: { mentionWakeup: false } });
  f.emit('private hello', { channel_type: 'PERSON', target_id: botId });
  f.emit(`${tag} private literal`, { channel_type: 'PERSON', target_id: botId });
  await f.flush();
  assert.deepEqual(f.submitted.map(prompt), ['private hello', `${tag} private literal`]);
  assert.ok(f.received.every(message => message.kind === 'private' && message.targetId === '1' && !message.mentionedBot));
});

test('bare mention, help and status stay local and do not invoke model', async t => {
  const f = fixture(t);
  for (const content of [tag, `${tag} /help`, `${tag} /status`]) { f.emit(content); await f.flush(); }
  assert.equal(f.created.length, 0); assert.equal(f.submitted.length, 0);
  assert.equal(f.sends.length, 3);
  assert.match(f.sends[2].text, /尚未创建会话/);
});

test('mentioned control commands operate only the current routed conversation', async t => {
  const f = fixture(t);
  f.emit(`${tag} start`); await f.flush();
  const first = f.submitted[0].id;
  f.emit(`${tag} /status`); await f.flush(); assert.ok(f.sends.at(-1).text.includes(first));
  f.emit(`${tag} /stop`); await f.flush(); assert.deepEqual(f.cancelled, [first]);
  f.emit(`${tag} /new`); await f.flush(); assert.deepEqual(f.disposed, [first]); assert.equal(f.routes.has(route()), false);
  f.emit(`${tag} another`); await f.flush(); assert.notEqual(f.submitted.at(-1).id, first);
  assert.equal(f.submitted.length, 2);
});

test('mentioned image command arms one same-user same-channel image within two minutes', async t => {
  const f = fixture(t);
  f.emit(`${tag} /image read screenshot`); await f.flush();
  const pending = f.bridge.imageRequests.get(route());
  assert.ok(pending.expiresAt > Date.now() + 119000);
  const image = { type: 2, extra: { attachments: { url: 'https://img.kookapp.cn/assets/test.png', name: 'test.png' } } };
  f.emit('https://img.kookapp.cn/assets/test.png', { ...image, author_id: '2' });
  f.emit('https://img.kookapp.cn/assets/test.png', { ...image, target_id: '200' });
  await f.flush(); assert.equal(f.admitted.length, 0);
  f.emit('https://img.kookapp.cn/assets/test.png', image); await f.flush();
  assert.equal(f.admitted.length, 1); assert.equal(prompt(f.submitted[0]), 'read screenshot');
  assert.equal(f.submitted[0].message.content[1].type, 'image');
  f.emit('https://img.kookapp.cn/assets/test.png', image); await f.flush(); assert.equal(f.admitted.length, 1);
  f.emit(`${tag} /image expired`); await f.flush();
  f.bridge.imageRequests.get(route()).expiresAt = Date.now() - 1;
  f.emit('https://img.kookapp.cn/assets/test.png', image); await f.flush(); assert.equal(f.admitted.length, 1);
});

test('duplicate mentioned event triggers one submission even when repeated before completion', async t => {
  const f = fixture(t);
  const patch = { msg_id: 'duplicate-official-mention' };
  f.emit(`${tag} once`, patch); f.emit(`${tag} once`, patch);
  await f.flush(); assert.equal(f.submitted.length, 1); assert.equal(f.received.length, 1);
});

test('mentioned stop cancels active and queued images before followup', async t => {
  let started, aborted = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { images: { admit: async (_items, signal) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  } } });
  f.emit(`${tag} /image inspect`); await f.flush();
  const image = { type: 2, extra: { attachments: { url: 'https://img.kookapp.cn/assets/test.png' } } };
  f.emit('https://img.kookapp.cn/assets/test.png', image); await ready;
  f.emit('https://img.kookapp.cn/assets/test.png', image);
  f.emit(`${tag} /stop`); await f.flush();
  assert.equal(aborted, 1); assert.equal(f.submitted.length, 0); assert.equal(f.created.length, 0);
  assert.equal(f.bridge.imageControllers.size, 0);
});

test('host config defaults mention wakeup on and validates its boolean type', () => {
  const base = { workspace: process.cwd(), allowedUsers: ['1'] };
  assert.equal(resolveConfig(base, {}).mentionWakeup, true);
  assert.equal(resolveConfig({ ...base, mentionWakeup: false }, {}).mentionWakeup, false);
  assert.equal(resolveConfig({ ...base, mentionWakeup: true }, {}).mentionWakeup, true);
  for (const value of ['false', 0, 1, null, {}]) assert.throws(() => resolveConfig({ ...base, mentionWakeup: value }, {}));
});

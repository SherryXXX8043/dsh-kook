import test from 'node:test';
import assert from 'node:assert/strict';
import { KookTransport } from '../src/transport.js';
import { KookBridge } from '../src/bridge.js';
import { KookImages, MAX_IMAGE_BYTES } from '../src/images.js';

const bot = '9001';
const tag = `(met)${bot}(met)`;
const urls = ['https://img.kookapp.cn/assets/first.png', 'https://img.kaiheila.cn/assets/second.png'];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let sequence = 0;
const key = (user = '1', channel = '100') => JSON.stringify(['channel', channel, user]);
const caption = item => item.message.content[0].text;
// KOOK's actual client upload layout: a section caption followed by a container.
function card(text = `${tag} 猜猜我是谁`, count = 1) {
  return JSON.stringify([{ theme: 'invisible', color: '', size: 'lg', expand: false,
    modules: [{ type: 'section', mode: 'left', accessory: null,
      text: { type: 'kmarkdown', content: text, elements: [] }, elements: [] },
    { type: 'container', elements: urls.slice(0, count).map(src => ({ type: 'image', src, alt: '', size: 'lg',
      circle: false, title: '', fallbackUrl: '', width: 288, height: 448, fileSize: 110289, elements: [] })) }], type: 'card' }]);
}
function fixture(t, overrides = {}) {
  const downloads = [], saves = [], submitted = [], replies = [], received = [], tasks = [], routes = new Map();
  const images = new KookImages({ attachments: {
    imageLimits: { maxImageBytes: MAX_IMAGE_BYTES, maxMessageImageBytes: MAX_IMAGE_BYTES, maxImagesPerMessage: 20 },
    async saveImages(inputs) {
      saves.push(inputs);
      return inputs.map((input, i) => ({ attachmentId: `sha256:${String(i + 1).padStart(64, '0')}`, mediaType: input.mediaType,
        bytes: input.data.length, width: 1, height: 1, name: input.name }));
    },
  }, fetchImpl: async (url, options) => { downloads.push({ url, options }); return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
  const bridge = new KookBridge({ config: { allowedUsers: ['1', '2'], allowedChannels: ['100', '200'], allowPrivate: true,
    autoForwardChannels: false, mentionWakeup: true, commandPrefix: '/nemo', memoryLimit: 0, knowledgeLimit: 0, ...overrides },
  store: { get: route => routes.get(route), async set(route, id) { if (id === undefined) routes.delete(route); else routes.set(route, id); } },
  agents: { async create(id) { return { agent: { id, followup: async message => submitted.push({ id, message }), cancel() {} }, async dispose() {} }; } },
  images, send: async (destination, text) => replies.push({ destination, text }), logger: { warn() {} } });
  const transport = new KookTransport({ token: 'fixture-only', onMessage: message => {
    received.push(message); const task = bridge.receive(message); tasks.push(task); return task;
  } });
  transport.running = true;
  transport.client = { me: { id: bot }, async destroy() {}, off() {} };
  const emit = (content = card(), patch = {}) => transport.receive({ type: 10, channel_type: 'GROUP', target_id: '100', author_id: '1',
    msg_id: `mention-image-${++sequence}`, content, extra: { mention: [bot], author: { bot: false } }, ...patch });
  const flush = () => Promise.all(tasks);
  const text = async (content, patch = {}) => { emit(content, { type: 9, ...patch }); await flush(); };
  t.after(async () => { await bridge.stop(); await transport.stop(); });
  return { bridge, transport, emit, flush, text, downloads, saves, submitted, replies, received, routes };
}

test('same actual type 10 card submits direct mention caption and two persisted images together once', async t => {
  const f = fixture(t);
  f.emit(card(`${tag} 猜猜我是谁`, 2)); await f.flush();
  assert.equal(f.submitted.length, 1);
  assert.equal(caption(f.submitted[0]), '猜猜我是谁');
  assert.deepEqual(f.submitted[0].message.content.map(block => block.type), ['text', 'image', 'image']);
  assert.deepEqual(f.downloads.map(item => item.url), urls);
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].length, 2);
  for (const block of f.submitted[0].message.content.slice(1)) {
    assert.match(block.attachment.attachmentId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(block.attachment.mediaType, 'image/png');
  }
  assert.equal(f.replies.length, 0, 'inline image must not enter waiting flow');
  assert.equal(f.bridge.imageRequests.size, 0);
});

test('role or same-name plain mention cannot download an inline image without actual bot mention', async t => {
  const f = fixture(t);
  for (const content of ['(rol)9001(rol) 猜猜我是谁', '(rol)79021149(rol) 猜猜我是谁', '@Nemo 猜猜我是谁', `${tag} fake`]) {
    f.emit(card(content), { extra: { mention: [], mention_roles: [9001, 79021149], author: { bot: false } } });
  }
  await f.flush();
  assert.equal(f.downloads.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.submitted.length, 0);
});

test('disabled wakeup and unauthorized sender or channel do not admit mentioned image cards', async t => {
  const disabled = fixture(t, { mentionWakeup: false });
  disabled.emit(); await disabled.flush(); assert.equal(disabled.downloads.length, 0);
  const f = fixture(t);
  f.emit(card(), { author_id: '99' }); f.emit(card(), { target_id: '999' });
  await f.flush(); assert.equal(f.downloads.length, 0); assert.equal(f.submitted.length, 0);
});

test('bot self and bot-authored image cards are filtered and duplicate direct mentions submit once', async t => {
  const f = fixture(t);
  f.emit(card(), { author_id: bot });
  f.emit(card(), { extra: { mention: [bot], author: { bot: true } } });
  f.emit(card(), { msg_id: 'one-inline-image' }); f.emit(card(), { msg_id: 'one-inline-image' });
  await f.flush();
  assert.equal(f.received.length, 1); assert.equal(f.downloads.length, 1); assert.equal(f.submitted.length, 1);
});

test('old pending image question cannot override caption on the newly mentioned image', async t => {
  const f = fixture(t);
  await f.text(`${tag} /image old pending question`);
  f.emit(card(`${tag} this image has a different question`)); await f.flush();
  assert.equal(caption(f.submitted[0]), 'this image has a different question');
  assert.equal(f.bridge.imageRequests.has(key()), false);
});

test('bare mention with image consumes a valid pending question when caption is empty', async t => {
  const f = fixture(t);
  await f.text(`${tag} /image inspect the weapon`);
  f.emit(card(tag)); await f.flush();
  assert.equal(caption(f.submitted[0]), 'inspect the weapon');
  assert.equal(f.submitted[0].message.content[1].type, 'image');
  assert.equal(f.bridge.imageRequests.has(key()), false);
});

test('bare mention with image and no pending request uses image description instead of empty help', async t => {
  const f = fixture(t);
  f.emit(card(tag)); await f.flush();
  assert.equal(f.submitted.length, 1);
  assert.match(caption(f.submitted[0]), /描述图片内容/);
  assert.equal(f.replies.length, 0);
});

test('inline image command strips its command and submits immediately without entering wait state', async t => {
  const f = fixture(t);
  f.emit(card(`${tag} /image 请识别这个人物`)); await f.flush();
  assert.equal(caption(f.submitted[0]), '请识别这个人物');
  assert.equal(f.submitted[0].message.content[1].type, 'image');
  assert.equal(f.bridge.imageRequests.size, 0); assert.equal(f.replies.length, 0);
  f.emit(card(`${tag} /image`)); await f.flush();
  assert.match(caption(f.submitted[1]), /描述图片内容/);
  assert.equal(f.bridge.imageRequests.size, 0);
});

test('prefix plus inline image command remains compatible when mention wakeup is disabled', async t => {
  const f = fixture(t, { mentionWakeup: false });
  f.emit(card('/nemo /image read this chart'), { extra: { mention: [], author: { bot: false } } }); await f.flush();
  assert.equal(caption(f.submitted[0]), 'read this chart');
  assert.equal(f.downloads.length, 1); assert.equal(f.replies.length, 0);
});

test('two-step image request stays single-use and cannot authorize another user or channel', async t => {
  const f = fixture(t);
  await f.text(`${tag} /image original two-step question`);
  const noMention = { extra: { mention: [], author: { bot: false } } };
  f.emit(card(''), { ...noMention, author_id: '2' }); f.emit(card(''), { ...noMention, target_id: '200' });
  await f.flush(); assert.equal(f.downloads.length, 0);
  f.emit(card(''), noMention); await f.flush();
  assert.equal(caption(f.submitted[0]), 'original two-step question');
  f.emit(card(''), noMention); await f.flush(); assert.equal(f.downloads.length, 1);
  f.emit(card(`${tag} user two question`), { author_id: '2' }); await f.flush();
  assert.equal(caption(f.submitted[1]), 'user two question');
  assert.notEqual(f.submitted[0].id, f.submitted[1].id);
});

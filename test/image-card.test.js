import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageCard, KookImages, MAX_IMAGE_BYTES } from '../src/images.js';
import { KookTransport } from '../src/transport.js';
import { KookBridge } from '../src/bridge.js';

const imageUrl = 'https://img.kookapp.cn/assets/test.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const image = (src = imageUrl, patch = {}) => ({ type: 'image', src, ...patch });
const card = modules => [{ type: 'card', modules }];
// Exact shape observed when the user uploaded one picture in a KOOK private chat.
const uploadedCard = () => [{ theme: 'invisible', color: '', size: 'lg', expand: false,
  modules: [{ type: 'container', elements: [{ type: 'image', src: imageUrl, alt: '', size: 'lg', circle: false,
    title: '', fallbackUrl: '', width: 534, height: 192, fileSize: 6388, elements: [] }] }], type: 'card' }];
const encode = value => JSON.stringify(value);
let sequence = 0;
function event(content = encode(uploadedCard()), patch = {}) {
  return { type: 10, channel_type: 'PERSON', target_id: 'bot-1', author_id: '1', msg_id: `card-${++sequence}`,
    content, extra: { author: { bot: false } }, ...patch };
}
function fixture(t, config = {}) {
  const normalized = [], downloads = [], saves = [], submissions = [], created = [], replies = [], warnings = [], pending = [];
  const routes = new Map();
  const attachments = {
    imageLimits: { maxImageBytes: MAX_IMAGE_BYTES, maxMessageImageBytes: MAX_IMAGE_BYTES, maxImagesPerMessage: 20 },
    async saveImages(inputs) {
      saves.push(inputs);
      return inputs.map((input, i) => ({ attachmentId: `sha256:${String(i + 1).padStart(64, '0')}`,
        mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }));
    },
  };
  const images = new KookImages({ attachments, fetchImpl: async (url, options) => {
    downloads.push({ url, options });
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  } });
  const bridge = new KookBridge({
    config: { allowedUsers: ['1', '2'], allowedChannels: ['10', '20'], allowPrivate: true, autoForwardChannels: false,
      commandPrefix: '/dsh', ownerUserId: '', pairingEnabled: false, memoryLimit: 0, knowledgeLimit: 0, ...config },
    store: { get: key => routes.get(key), async set(key, id) { if (id === undefined) routes.delete(key); else routes.set(key, id); } },
    agents: { async create(id) {
      created.push(id);
      return { agent: { id, followup: async message => submissions.push({ id, message }), cancel() {} }, async dispose() {} };
    } },
    images, send: async (destination, text) => replies.push({ destination, text }), logger: { warn: text => warnings.push(text) },
  });
  const transport = new KookTransport({ token: 'fixture-only', onMessage: message => {
    normalized.push(message);
    const work = bridge.receive(message); pending.push(work); return work;
  } });
  // Exercise public event normalization, without opening a socket or making KOOK API calls.
  transport.running = true;
  transport.client = { me: { id: 'bot-1' }, destroy() {}, off() {} };
  t.after(async () => { await bridge.stop(); await transport.stop(); });
  async function receive(value) { transport.receive(value); await Promise.all(pending.splice(0)); }
  return { receive, transport, bridge, normalized, downloads, saves, submissions, created, replies, warnings, routes };
}

test('observed private type 10 upload traverses transport, bridge and attachment admission as one image message', async t => {
  const f = fixture(t);
  await f.receive(event());
  assert.equal(f.normalized.length, 1);
  assert.deepEqual(f.normalized[0].images, [{ url: imageUrl, name: '' }]);
  assert.equal(f.normalized[0].text, '');
  assert.equal(f.normalized[0].kind, 'private');
  assert.equal(f.normalized[0].targetId, '1');
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].url, imageUrl);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0][0].data, png);
  assert.equal(f.created.length, 1);
  assert.equal(f.submissions.length, 1);
  const { message } = f.submissions[0];
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content.map(block => block.type), ['text', 'image']);
  assert.ok(message.content[0].text.length > 0);
  assert.match(message.content[1].attachment.attachmentId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(message.content[1].attachment.mediaType, 'image/png');
});

test('card plain text and KMarkdown accompany images in a single followup preserving order', async t => {
  const f = fixture(t);
  const modules = [{ type: 'header', text: { type: 'plain-text', content: '请看截图' } },
    { type: 'section', text: { type: 'kmarkdown', content: '**报错是什么？**' }, accessory: image(imageUrl, { title: 'screenshot.png' }) },
    { type: 'image-group', elements: [image('https://img.kaiheila.cn/assets/second.png')] }];
  await f.receive(event(encode(card(modules))));
  assert.equal(f.submissions.length, 1);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].length, 2);
  assert.deepEqual(f.submissions[0].message.content.map(block => block.type), ['text', 'image', 'image']);
  assert.equal(f.submissions[0].message.content[0].text, '请看截图\n**报错是什么？**');
  assert.equal(f.saves[0][0].name, 'screenshot.png');
  assert.deepEqual(f.downloads.map(item => item.url), [imageUrl, 'https://img.kaiheila.cn/assets/second.png']);
});

test('channel command arms only the same user and channel for one type 10 card', async t => {
  const f = fixture(t);
  const group = { channel_type: 'GROUP', target_id: '10' };
  await f.receive(event('/dsh /image 请识别红框报错', { ...group, type: 1 }));
  await f.receive(event(undefined, { ...group, author_id: '2' }));
  await f.receive(event(undefined, { ...group, target_id: '20' }));
  assert.equal(f.downloads.length, 0);
  await f.receive(event(undefined, group));
  assert.equal(f.submissions.length, 1);
  assert.match(f.submissions[0].message.content[0].text, /请识别红框报错/);
  await f.receive(event(undefined, group));
  assert.equal(f.downloads.length, 1);
});

test('card text with channel prefix submits its own text and image without arming a different user', async t => {
  const f = fixture(t);
  const content = encode(card([{ type: 'section', text: { type: 'plain-text', content: '/dsh 请分析图表' }, accessory: image() }]));
  await f.receive(event(content, { channel_type: 'GROUP', target_id: '10' }));
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].message.content[0].text, '请分析图表');
  await f.receive(event(undefined, { channel_type: 'GROUP', target_id: '10', author_id: '2' }));
  assert.equal(f.submissions.length, 1);
});

test('private image command cannot authorize a card in a channel or another private user', async t => {
  const f = fixture(t);
  await f.receive(event('/image 我的私人问题', { type: 1 }));
  await f.receive(event(undefined, { channel_type: 'GROUP', target_id: '10' }));
  assert.equal(f.downloads.length, 0);
  await f.receive(event(undefined, { author_id: '2' }));
  assert.equal(f.submissions.length, 1);
  assert.doesNotMatch(f.submissions[0].message.content[0].text, /我的私人问题/);
  await f.receive(event());
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[1].message.content[0].text, '我的私人问题');
  assert.notEqual(f.submissions[0].id, f.submissions[1].id);
});

test('card authorization precedes downloads and persistence in private and forwarded channel modes', async t => {
  const f = fixture(t, { autoForwardChannels: true });
  for (const patch of [{ author_id: '99' }, { channel_type: 'GROUP', target_id: '99' },
    { channel_type: 'GROUP', target_id: '10', author_id: '99' }]) await f.receive(event(undefined, patch));
  assert.equal(f.downloads.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.created.length, 0);
  await f.receive(event(undefined, { channel_type: 'GROUP', target_id: '10' }));
  assert.equal(f.submissions.length, 1);
});

test('disabled private messages ignore otherwise valid image cards', async t => {
  const f = fixture(t, { allowPrivate: false });
  await f.receive(event());
  assert.equal(f.downloads.length, 0); assert.equal(f.submissions.length, 0);
});

test('bot and self image cards are ignored and duplicate message ids submit once', async t => {
  const f = fixture(t);
  await f.receive(event(undefined, { extra: { author: { bot: true } } }));
  await f.receive(event(undefined, { author_id: 'bot-1' }));
  assert.equal(f.normalized.length, 0);
  const incoming = event();
  await f.receive(incoming); await f.receive(incoming);
  assert.equal(f.downloads.length, 1); assert.equal(f.submissions.length, 1);
});

test('parser leaves external URL validation to KookImages which rejects before network and followup', async t => {
  const f = fixture(t);
  const content = encode(card([{ type: 'container', elements: [image('https://example.test/private.png')] }]));
  assert.equal(parseImageCard(content).images[0].url, 'https://example.test/private.png');
  await f.receive(event(content));
  assert.equal(f.normalized.length, 1);
  assert.equal(f.downloads.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.created.length, 0);
  assert.equal(f.submissions.length, 0);
  assert.match(f.replies.at(-1).text, /IMAGE_URL/);
  assert.doesNotMatch(f.replies.at(-1).text, /example\.test/);
});

test('malformed JSON, malformed cards and text-only cards are ignored without downloading', async t => {
  const f = fixture(t);
  const contents = ['{', 'null', '{}', '[]', '[null]', encode([{ type: 'card', modules: {} }]),
    encode([{ type: 'not-card', modules: [] }]), encode(card([{ type: 'header', text: { type: 'plain-text', content: 'hello' } }]))];
  for (const content of contents) {
    assert.equal(parseImageCard(content), undefined, content);
    await f.receive(event(content));
  }
  assert.equal(parseImageCard({}), undefined);
  assert.equal(f.normalized.length, 0); assert.equal(f.downloads.length, 0); assert.equal(f.submissions.length, 0);
});

test('only supported image locations and text types are extracted without recursive traversal', () => {
  const parsed = parseImageCard(encode(card([
    { type: 'context', elements: [image('https://ignored.test/a')] },
    { type: 'container', elements: [{ type: 'button', value: imageUrl }, { type: 'container', elements: [image('https://ignored.test/nested')] }, image(imageUrl)] },
    { type: 'section', text: { type: 'button', content: 'ignored text' }, accessory: image('https://img.kookapp.cn/accessory.png') },
    { type: 'header', text: { type: 'plain-text', content: 'accepted header' } },
  ])));
  assert.equal(parsed.text, 'accepted header');
  assert.deepEqual(parsed.images.map(item => item.url), [imageUrl, 'https://img.kookapp.cn/accessory.png']);
});

test('parser applies the 128 KiB limit to UTF-8 bytes, accepting exactly the boundary', () => {
  const base = encode(card([{ type: 'container', elements: [image()] }, { type: 'header', text: { type: 'plain-text', content: '' } }]));
  const padding = 128 * 1024 - Buffer.byteLength(base);
  const value = JSON.parse(base);
  value[0].modules[1].text.content = 'x'.repeat(padding);
  const exact = encode(value);
  assert.equal(Buffer.byteLength(exact), 128 * 1024);
  assert.equal(parseImageCard(exact).images.length, 1);
  value[0].modules[1].text.content += 'x';
  assert.equal(parseImageCard(encode(value)), undefined);
  value[0].modules[1].text.content = '图'.repeat(Math.floor(padding / 2));
  assert.ok(encode(value).length < 128 * 1024);
  assert.ok(Buffer.byteLength(encode(value)) > 128 * 1024);
  assert.equal(parseImageCard(encode(value)), undefined);
});

test('parser accepts ten cards and rejects eleven without partial output', () => {
  const one = { type: 'card', modules: [{ type: 'container', elements: [image()] }] };
  assert.equal(parseImageCard(encode(Array.from({ length: 10 }, () => one))).images.length, 10);
  assert.equal(parseImageCard(encode(Array.from({ length: 11 }, () => one))), undefined);
});

test('parser enforces 100 modules across cards rather than separately per card', () => {
  const module = { type: 'header', text: { type: 'plain-text', content: 'text' } };
  const cards = [{ type: 'card', modules: [{ type: 'container', elements: [image()] }, ...Array(49).fill(module)] },
    { type: 'card', modules: Array(50).fill(module) }];
  assert.equal(parseImageCard(encode(cards)).images.length, 1);
  cards[1].modules.push(module);
  assert.equal(parseImageCard(encode(cards)), undefined);
});

test('parser permits twenty images and rejects the twenty-first in container or section accessory', () => {
  const modules = [{ type: 'image-group', elements: Array.from({ length: 20 }, () => image()) }];
  assert.equal(parseImageCard(encode(card(modules))).images.length, 20);
  for (const extra of [{ type: 'container', elements: [image()] }, { type: 'section', accessory: image() }]) {
    assert.equal(parseImageCard(encode(card([...modules, extra]))), undefined);
  }
});

test('oversized image card is dropped by transport before any downstream image work', async t => {
  const f = fixture(t);
  const tooMany = encode(card([{ type: 'container', elements: Array.from({ length: 21 }, () => image()) }]));
  await f.receive(event(tooMany));
  assert.equal(f.normalized.length, 0); assert.equal(f.downloads.length, 0);
  assert.equal(f.saves.length, 0); assert.equal(f.submissions.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { KookImages, MAX_IMAGE_BYTES, kookImageUrl, imageMediaType } from '../src/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const url = 'https://img.kookapp.cn/assets/image.png';
function fixture(overrides = {}) {
  const saved = [], validated = [], calls = [];
  const attachments = {
    imageLimits: { maxImageBytes: MAX_IMAGE_BYTES, maxMessageImageBytes: MAX_IMAGE_BYTES, maxImagesPerMessage: 4 },
    async saveImages(inputs) { saved.push(inputs); return inputs.map((_, i) => ({ id: `image-${i}` })); },
    async validateImage(input) { validated.push(input); },
    isAttachmentError: error => error?.attachment === true,
    ...overrides.attachments,
  };
  const fetchImpl = overrides.fetchImpl ?? (async (value, options) => {
    calls.push({ value, options });
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  return { saved, validated, calls, service: new KookImages({ workspace: '/work', ...overrides, attachments, fetchImpl }) };
}
const code = expected => error => error?.code === expected;

test('image URLs accept exact current and legacy HTTPS CDNs only', () => {
  assert.equal(kookImageUrl(url), url);
  assert.equal(kookImageUrl('https://img.kaiheila.cn/a.png'), 'https://img.kaiheila.cn/a.png');
  assert.equal(kookImageUrl('https://img.kookapp.cn:443/a.png'), 'https://img.kookapp.cn/a.png');
  for (const value of ['http://img.kookapp.cn/a', 'https://img.kookapp.cn.evil.test/a', 'https://evil.test/img.kookapp.cn/a', 'https://user:secret@img.kookapp.cn/a', 'https://img.kookapp.cn:8443/a', 'file:///work/a.png', 'data:image/png;base64,AAAA', '//img.kookapp.cn/a']) {
    assert.throws(() => kookImageUrl(value), code('IMAGE_URL'), value);
  }
});

test('actual image signatures choose format rather than filename', () => {
  assert.equal(imageMediaType(png), 'image/png');
  assert.equal(imageMediaType(Buffer.from([255, 216, 255, 0])), 'image/jpeg');
  assert.equal(imageMediaType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageMediaType(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
  for (const data of [Buffer.alloc(0), Buffer.from('<svg></svg>'), Buffer.from('<html>not a picture</html>')]) assert.throws(() => imageMediaType(data), code('IMAGE_FORMAT'));
});

test('admission saves actual bytes through host and returns persisted image blocks', async () => {
  const { service, saved, calls } = fixture();
  const blocks = await service.admit([{ url, name: '../../unsafe\\photo.png' }]);
  assert.deepEqual(blocks, [{ type: 'image', attachment: { id: 'image-0' } }]);
  assert.deepEqual(saved[0][0].data, png);
  assert.equal(saved[0][0].name, 'photo.png');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers, undefined);
});

test('untrusted URL is rejected before any download or host write', async () => {
  const { service, calls, saved } = fixture();
  await assert.rejects(service.admit([{ url: 'https://localhost/private.png' }]), code('IMAGE_URL'));
  assert.equal(calls.length, 0); assert.equal(saved.length, 0);
});

test('oversized declared length is rejected before reading body', async () => {
  let cancelled = false, reads = 0;
  const { service, saved } = fixture({ fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-length': String(MAX_IMAGE_BYTES + 1) }), body: { locked: false, cancel: async () => { cancelled = true; }, async *[Symbol.asyncIterator]() { reads++; yield png; } } }) });
  await assert.rejects(service.admit([{ url }]), code('IMAGE_TOO_LARGE'));
  assert.equal(reads, 0); assert.equal(cancelled, true); assert.equal(saved.length, 0);
});

test('stream size cap applies when length header is missing or dishonest', async () => {
  const { service, saved } = fixture({ attachments: { imageLimits: { maxImageBytes: 16, maxMessageImageBytes: 32, maxImagesPerMessage: 4 } }, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(png.subarray(0, 12)); controller.enqueue(png.subarray(12)); controller.close(); } }), { headers: { 'content-length': '1' } }) });
  await assert.rejects(service.admit([{ url }]), code('IMAGE_TOO_LARGE'));
  assert.equal(saved.length, 0);
});

test('batch total and image count limits reject without storing partial images', async () => {
  const { service, saved } = fixture({ attachments: { imageLimits: { maxImageBytes: 1000, maxMessageImageBytes: png.length + 5, maxImagesPerMessage: 2 } } });
  await assert.rejects(service.admit([{ url }, { url }]), code('IMAGE_TOO_LARGE'));
  assert.equal(saved.length, 0);
  await assert.rejects(service.admit([{ url }, { url }, { url }]), code('IMAGE_TOO_LARGE'));
  assert.equal(saved.length, 0);
});

test('format mismatch and nonimage response never reach attachment storage', async () => {
  for (const [body, type] of [[png, 'image/jpeg'], [Buffer.from('<html>error</html>'), 'image/png']]) {
    const { service, saved } = fixture({ fetchImpl: async () => new Response(body, { headers: { 'content-type': type } }) });
    await assert.rejects(service.admit([{ url }]), code('IMAGE_FORMAT'));
    assert.equal(saved.length, 0);
  }
});

test('octet-stream images are accepted only after signature recognition', async () => {
  const { service, saved } = fixture({ fetchImpl: async () => new Response(png, { headers: { 'content-type': 'application/octet-stream' } }) });
  await service.admit([{ url }]);
  assert.equal(saved[0][0].mediaType, 'image/png');
});

test('redirect failure is not followed and does not persist an attachment', async () => {
  const { service, saved } = fixture({ fetchImpl: async (_value, options) => { assert.equal(options.redirect, 'error'); throw new TypeError('redirect forbidden'); } });
  await assert.rejects(service.admit([{ url }]), code('IMAGE_DOWNLOAD'));
  assert.equal(saved.length, 0);
});

test('host full decode validation failures reject the batch', async () => {
  let checked = false;
  const { service } = fixture({ attachments: { async saveImages() { checked = true; throw Object.assign(new Error('invalid decoded pixels'), { attachment: true }); } } });
  await assert.rejects(service.admit([{ url }]), code('IMAGE_FORMAT'));
  assert.equal(checked, true);
});

test('cancelled download aborts fetch, stores nothing, and releases admission slot', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service, saved } = fixture({ fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
  }) });
  const pending = service.admit([{ url }], controller.signal);
  const rejected = assert.rejects(pending, code('IMAGE_DOWNLOAD'));
  await ready; controller.abort(); await rejected;
  assert.equal(saved.length, 0); assert.equal(service.active, 0);
});

test('pre-aborted lifetime prevents download and persistence', async () => {
  const controller = new AbortController(); controller.abort();
  const { service, calls, saved } = fixture({ signal: controller.signal });
  await assert.rejects(service.admit([{ url }]), code('IMAGE_DOWNLOAD'));
  assert.equal(calls.length, 0); assert.equal(saved.length, 0);
});

function localFs({ contained = true, data = png, readError } = {}) {
  const calls = [];
  return { calls, async resolve(path, options) { calls.push(['resolve', path, options]); return { displayPath: path }; }, contains() { return contained; }, async readBytes(target, signal, limit) { calls.push(['read', target, signal, limit]); if (readError) throw readError; return data; } };
}

test('local image uses host resolved containment, bounded reads, and image validator', async () => {
  const fs = localFs(); const { service, validated } = fixture({ fs });
  const input = await service.readLocal('/work/picture.png');
  assert.equal(input.name, 'picture.png'); assert.deepEqual(input.data, png);
  assert.equal(validated.length, 1);
  assert.equal(fs.calls.find(call => call[0] === 'read')[3], MAX_IMAGE_BYTES);
  assert.equal(fs.calls[1][2].cwd, '/work');
});

test('outside-workspace resolved targets are rejected before reading', async () => {
  const fs = localFs({ contained: false }); const { service, validated } = fixture({ fs });
  await assert.rejects(service.readLocal('../secret.png'), code('IMAGE_PATH'));
  assert.equal(fs.calls.some(call => call[0] === 'read'), false); assert.equal(validated.length, 0);
});

test('host bounded-read overflow is reported as too large', async () => {
  const fs = localFs({ readError: Object.assign(new Error('large'), { code: 'FS_TOO_LARGE' }) });
  const { service } = fixture({ fs });
  await assert.rejects(service.readLocal('/work/large.png'), code('IMAGE_TOO_LARGE'));
});

test('local corrupted image rejected by host validator cannot be returned', async () => {
  const { service } = fixture({ fs: localFs(), attachments: { async validateImage() { throw new Error('corrupted image'); } } });
  await assert.rejects(service.readLocal('/work/corrupt.png'));
});

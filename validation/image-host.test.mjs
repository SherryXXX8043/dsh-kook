import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import { KookImages, parseImageCard } from '../src/images.js';

// Run with the installed Electron runtime and --import ./validation/runtime-hooks.mjs.
// Storage is isolated below this repository, never the user's actual DSH home.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t, config = {}) {
  const parent = resolve('.npm-cache');
  await mkdir(parent, { recursive: true });
  const dshHome = await mkdtemp(`${parent}/image-host-`);
  const ctx = new Context();
  const plugin = ctx.plugin(LocalAttachmentStore, { dshHome, ...config });
  await plugin;
  t.after(() => plugin.dispose());
  return { attachments: ctx.attachments, dshHome };
}

test('KOOK image survives real installed DSH normalization and verified storage readback', async t => {
  const { attachments, dshHome } = await fixture(t);
  const images = new KookImages({ attachments,
    fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) });
  const [block] = await images.admit([{ url: 'https://img.kookapp.cn/assets/test.png', name: 'test.png' }]);
  assert.equal(block.type, 'image');
  assert.match(block.attachment.attachmentId, /^sha256:[a-f0-9]{64}$/);
  const readback = await attachments.readImage(block.attachment);
  assert.ok(readback.data.length > 0);
  assert.equal(readback.ref.width, 1);
  assert.equal(readback.ref.height, 1);
  assert.ok(attachments.imageHostPath(block.attachment).startsWith(resolve(dshHome)));
});

test('real installed DSH refuses PNG-looking bytes that cannot fully decode', async t => {
  const { attachments } = await fixture(t);
  const images = new KookImages({ attachments,
    fetchImpl: async () => new Response(png.subarray(0, 24), { headers: { 'content-type': 'image/png' } }) });
  await assert.rejects(images.admit([{ url: 'https://img.kookapp.cn/assets/broken.png' }]), error => error.code === 'IMAGE_FORMAT');
});

test('real image card parsing feeds installed DSH attachment storage', async t => {
  const { attachments } = await fixture(t);
  const parsed = parseImageCard(JSON.stringify([{ type: 'card', modules: [{ type: 'container', elements: [
    { type: 'image', src: 'https://img.kookapp.cn/assets/card.png', title: '' },
  ] }] }]));
  assert.ok(parsed);
  const images = new KookImages({ attachments, fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) });
  const [block] = await images.admit(parsed.images);
  const stored = await attachments.readImage(block.attachment);
  assert.equal(stored.ref.width, 1);
  assert.equal(stored.ref.height, 1);
});

test('real installed DSH batch limit is enforced through the KOOK adapter', async t => {
  const { attachments } = await fixture(t, { maxImagesPerMessage: 1 });
  let downloads = 0;
  const images = new KookImages({ attachments, fetchImpl: async () => { downloads++; return new Response(png); } });
  await assert.rejects(images.admit([{ url: 'https://img.kookapp.cn/a.png' }, { url: 'https://img.kookapp.cn/b.png' }]), error => error.code === 'IMAGE_TOO_LARGE');
  assert.equal(downloads, 0);
});

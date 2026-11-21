import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageTool } from '../src/image-tool.js';
import { KookError } from '../src/errors.js';

const input = { data: Buffer.from([137, 80, 78, 71]), mediaType: 'image/png', name: 'picture.png' };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture({ kind = 'channel' } = {}) {
  const agent = { id: 'agent-1' };
  const target = { kind, targetId: `${kind}-1` };
  const reads = [], sends = [], queued = [], warnings = [];
  const bridge = { stopped: false, lifetime: new AbortController(),
    handles: new Map([['route-1', { agent }]]), destinations: new Map([[agent.id, target]]),
    async queueDelivery(destination, operation) { queued.push(destination); return operation(); },
  };
  const images = { async readLocal(path, signal) { reads.push({ path, signal }); signal.throwIfAborted(); return input; } };
  const transport = { async sendImage(destination, image, signal) {
    sends.push({ destination, image, signal }); signal.throwIfAborted(); return { msg_id: 'sent' };
  } };
  const logger = { warn: message => warnings.push(message) };
  const tool = createImageTool({ bridge, images, transport, logger });
  const controller = new AbortController();
  return { agent, target, bridge, images, transport, tool, controller, reads, sends, queued, warnings,
    exec: { agent, signal: controller.signal } };
}

test('image tool sends only to its current Agent destination through the delivery queue', async t => {
  for (const kind of ['channel', 'private']) {
    await t.test(kind, async () => {
      const f = fixture({ kind });
      const result = await f.tool.execute({ path: 'screenshots/picture.png' }, f.exec);
      assert.equal(result.status, 'sent');
      assert.equal(f.reads.length, 1);
      assert.equal(f.reads[0].path, 'screenshots/picture.png');
      assert.deepEqual(f.queued, [f.target]);
      assert.equal(f.sends.length, 1);
      assert.equal(f.sends[0].destination, f.target);
      assert.equal(f.sends[0].image, input);
      assert.equal(f.sends[0].signal, f.reads[0].signal);
      assert.deepEqual(f.warnings, []);
      assert.deepEqual(f.tool.output.render({}, result), [{ type: 'text', text: result.message }]);
      assert.equal(f.tool.isConcurrencySafe(), false);
      assert.equal(f.tool.parameters.additionalProperties, false);
      assert.deepEqual(f.tool.parameters.required, ['path']);
    });
  }
});

test('image tool refuses absent, stale, foreign and stopped Agent routes before reading', async t => {
  const cases = {
    'missing destination': f => f.bridge.destinations.clear(),
    'missing handle': f => f.bridge.handles.clear(),
    'same id but different Agent object': f => { f.exec.agent = { id: f.agent.id }; },
    'different Agent id': f => { f.exec.agent = { id: 'agent-2' }; },
    'no Agent': f => { delete f.exec.agent; },
    'stopped bridge': f => { f.bridge.stopped = true; },
  };
  for (const [name, alter] of Object.entries(cases)) {
    await t.test(name, async () => {
      const f = fixture(); alter(f);
      await assert.rejects(f.tool.execute({ path: 'picture.png' }, f.exec), error => error.code === 'IMAGE_ROUTE');
      assert.deepEqual(f.reads, []);
      assert.deepEqual(f.queued, []);
      assert.deepEqual(f.sends, []);
    });
  }
});

test('invalid image paths are rejected before read or delivery', async () => {
  const f = fixture();
  for (const args of [undefined, null, {}, { path: null }, { path: 42 }, { path: '' }, { path: ' \t\n' }]) {
    await assert.rejects(f.tool.execute(args, f.exec), error => error.code === 'IMAGE_PATH');
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.queued, []);
  assert.deepEqual(f.sends, []);
});

test('local read/validation errors propagate without uploading or retrying', async () => {
  const f = fixture();
  const failure = new KookError('IMAGE_PATH');
  let reads = 0;
  f.images.readLocal = async () => { reads++; throw failure; };
  await assert.rejects(f.tool.execute({ path: '../outside.png' }, f.exec), error => error === failure);
  assert.equal(reads, 1);
  assert.deepEqual(f.queued, []);
  assert.deepEqual(f.sends, []);
});

test('Agent and plugin cancellation reach local reads before any delivery', async t => {
  for (const source of ['agent', 'plugin']) {
    await t.test(source, async () => {
      const f = fixture();
      (source === 'agent' ? f.controller : f.bridge.lifetime).abort();
      await assert.rejects(f.tool.execute({ path: 'picture.png' }, f.exec), { name: 'AbortError' });
      assert.equal(f.reads[0].signal.aborted, true);
      assert.deepEqual(f.queued, []);
      assert.deepEqual(f.sends, []);
    });
  }
});

test('cancel during upload returns unconfirmed once and never starts another send', async t => {
  for (const source of ['agent', 'plugin']) {
    await t.test(source, async () => {
      const f = fixture();
      const entered = deferred();
      let calls = 0;
      f.transport.sendImage = async (_destination, _image, signal) => {
        calls++;
        entered.resolve(signal);
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      };
      const pending = f.tool.execute({ path: 'picture.png' }, f.exec);
      const signal = await entered.promise;
      (source === 'agent' ? f.controller : f.bridge.lifetime).abort();
      assert.equal(signal.aborted, true);
      const result = await pending;
      assert.equal(result.status, 'unconfirmed');
      assert.match(result.message, /IMAGE_SEND/);
      assert.equal(calls, 1);
      assert.equal(f.queued.length, 1);
      assert.equal(f.warnings.length, 1);
    });
  }
});

test('ambiguous upload/message and queue failures return sanitized unconfirmed results without retry', async t => {
  for (const stage of ['send', 'queue']) {
    await t.test(stage, async () => {
      const f = fixture();
      const secret = 'private-token-and-host-path';
      let calls = 0;
      if (stage === 'send') f.transport.sendImage = async () => { calls++; throw new Error(secret); };
      else f.bridge.queueDelivery = async () => { calls++; throw new Error(secret); };
      const result = await f.tool.execute({ path: 'picture.png' }, f.exec);
      assert.equal(result.status, 'unconfirmed');
      assert.match(result.message, /IMAGE_SEND/);
      assert.doesNotMatch(result.message, new RegExp(secret));
      assert.equal(calls, 1);
      assert.equal(f.warnings.length, 1);
      assert.doesNotMatch(f.warnings[0], new RegExp(secret));
      if (stage === 'queue') assert.deepEqual(f.sends, []);
    });
  }
});

test('image delivery waits in the bridge queue after preceding text delivery', async () => {
  const f = fixture();
  const release = deferred(), enqueued = deferred();
  const order = [];
  let tail = release.promise.then(() => order.push('text sent'));
  f.bridge.queueDelivery = (destination, operation) => {
    assert.equal(destination, f.target);
    const pending = tail.then(operation);
    tail = pending.catch(() => {});
    enqueued.resolve();
    return pending;
  };
  f.transport.sendImage = async (_target, image) => { assert.equal(image, input); order.push('image sent'); };
  let completed = false;
  const pending = f.tool.execute({ path: 'picture.png' }, f.exec).then(result => { completed = true; return result; });
  await enqueued.promise;
  assert.deepEqual(order, []);
  assert.equal(completed, false);
  release.resolve();
  assert.equal((await pending).status, 'sent');
  assert.deepEqual(order, ['text sent', 'image sent']);
});

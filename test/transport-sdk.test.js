import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { KookClient } from '@kookapp/js-sdk';
import { KookTransport } from '../src/transport.js';

// Protocol follows @kookapp/js-sdk 0.1.4 dist/client/client.js,
// dist/ws/ws-client.js and dist/http/rest-client.js. No real KOOK endpoints.
const token = 'local-sdk-test-token';
const quiet = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark'].map(key => [key, () => {}]));
const timing = {
  handshakeTimeoutMs: 500, heartbeatIntervalMs: 100,
  heartbeatTimeoutMs: 500, pongTimeoutMs: 500, resumeTimeoutMs: 500,
  gatewayRetryDelayMs: 10, gatewayRetryFinalDelayMs: 20,
  gatewayPostDisconnectDelayMs: 10, resumeFirstDelayMs: 10,
  resumeFinalDelayMs: 20, infiniteRetryInitialMs: 10,
  infiniteRetryMaxMs: 40, eventGapTimeoutMs: 500,
};
async function until(predicate, description, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(5);
  }
}
function event(id, overrides = {}) {
  return { channel_type: 'GROUP', type: 1, target_id: 'channel-1',
    author_id: 'user-1', content: `text ${id}`, msg_id: id, msg_timestamp: Date.now(),
    extra: { author: { id: 'user-1', bot: false } }, ...overrides };
}
async function fixture(t, { requestTimeoutMs = 500, failFirstSelf = false,
  uploadFailure, imageMessageFailure, uploadUrl = 'https://img.kookapp.cn/assets/local-image.png' } = {}) {
  const requests = [], connections = [], frames = [], clients = [], messages = [], statuses = [];
  const sockets = new Set();
  let selfCalls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const multipart = contentType.startsWith('multipart/form-data');
    const body = multipart ? await new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': contentType }, body: bytes,
    }).formData() : undefined;
    const file = body?.get('file');
    const url = new URL(req.url, 'http://localhost');
    const record = { path: url.pathname, query: url.searchParams, method: req.method,
      authorization: req.headers.authorization,
      body: multipart ? undefined : bytes.length ? JSON.parse(bytes.toString()) : undefined,
      contentType, file: file ? { name: file.name, mediaType: file.type,
        data: Buffer.from(await file.arrayBuffer()) } : undefined,
      closed: false };
    requests.push(record);
    res.on('close', () => { record.closed = true; });
    const respond = (data, code = 0, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ code, message: code ? 'local failure' : '', data }));
    };
    if (url.pathname === '/api/v3/user/me') {
      selfCalls++;
      return respond({ id: 'bot-1', username: 'local-bot', bot: true }, failFirstSelf && selfCalls === 1 ? 401 : 0);
    }
    if (url.pathname === '/api/v3/gateway/index') return respond({ url: `ws://127.0.0.1:${server.address().port}/gateway` });
    const fail = mode => {
      if (mode === 'hang') return;
      if (mode === 'rate-limit') return respond({}, 429, 429);
      if (mode === 'api-error') return respond({}, 40001);
      if (mode === 'http-error') return respond({}, 0, 503);
      if (mode === 'bad-json') { res.writeHead(200); return res.end('not json'); }
    };
    if (url.pathname === '/api/v3/asset/create') {
      if (uploadFailure) return fail(uploadFailure);
      return respond({ url: uploadUrl });
    }
    if (['/api/v3/message/create', '/api/v3/direct-message/create'].includes(url.pathname)) {
      if (record.body.type === 2 && imageMessageFailure) return fail(imageMessageFailure);
      if (record.body.content === 'hang') return;
      if (record.body.content === 'rate-limit') return respond({}, 429, 429);
      if (record.body.content === 'api-error') return respond({}, 40001);
      if (record.body.content === 'http-error') return respond({}, 0, 503);
      if (record.body.content === 'bad-json') { res.writeHead(200); return res.end('not json'); }
      return respond({ msg_id: 'sent-id', msg_timestamp: 123 });
    }
    respond({}, 404, 404);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const connection = { socket, query: new URL(req.url, 'http://localhost').searchParams, closed: false };
    connections.push(connection);
    socket.on('close', () => { connection.closed = true; });
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.s === 2) socket.send(JSON.stringify({ s: 3 }));
      if (frame.s === 4) socket.send(JSON.stringify({ s: 6, d: { session_id: 'local-session' } }));
    });
    socket.send(JSON.stringify(connection.query.get('resume') === '1'
      ? { s: 6, d: { session_id: 'local-session' } }
      : { s: 1, d: { code: 0, session_id: 'local-session' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const transport = new KookTransport({ token, requestTimeoutMs, retryBaseMs: 10, retryMaxMs: 40,
    logger: quiet, onMessage: message => messages.push(message), onStatus: state => statuses.push(state),
    clientFactory: config => {
      const client = new KookClient({ ...config, baseUrl: `http://127.0.0.1:${server.address().port}`, timing });
      clients.push(client);
      return client;
    },
  });
  t.after(async () => {
    await transport.stop();
    for (const client of clients) client.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  transport.start();
  await until(() => statuses.includes('online'), 'real SDK handshake');
  return { transport, requests, connections, frames, clients, messages, statuses,
    sendEvent: (sn, data, connection = connections.at(-1)) => connection.socket.send(JSON.stringify({ s: 0, sn, d: data })) };
}

test('official SDK performs bot lookup, uncompressed gateway handshake and heartbeat', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.requests.slice(0, 2).map(r => r.path), ['/api/v3/user/me', '/api/v3/gateway/index']);
  assert.equal(f.requests[1].query.get('compress'), '0');
  assert.ok(f.requests.every(r => r.authorization === `Bot ${token}`));
  assert.equal(f.clients[0].me.id, 'bot-1');
  assert.equal(f.clients[0].ws.sessionId, 'local-session');
  await until(() => f.frames.some(frame => frame.s === 2), 'SDK heartbeat');
  assert.equal(f.clients.length, 1);
});

test('official raw events normalize group/private text and images and reject bot/unsupported messages', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.sendEvent(1, event('group'));
  f.sendEvent(2, event('private', { channel_type: 'PERSON', type: 9, target_id: 'bot-1', author_id: 'person-2' }));
  f.sendEvent(3, event('image', { type: 2, content: 'https://img.kookapp.cn/fallback.png',
    extra: { attachments: { url: 'https://img.kookapp.cn/attachment.png', name: 'photo.png' } } }));
  f.sendEvent(4, event('bot', { extra: { author: { bot: true } } }));
  f.sendEvent(5, event('system', { type: 255 }));
  f.sendEvent(6, event('group')); // Same message id with a new sequence number.
  f.sendEvent(7, event('private-image', { channel_type: 'PERSON', type: 2,
    target_id: 'bot-1', author_id: 'person-2', content: 'https://img.kookapp.cn/private.png' }));
  f.sendEvent(8, event('unsupported-file', { type: 4 }));
  f.sendEvent(9, event('last'));
  await until(() => f.messages.some(m => m.id === 'last'), 'all event frames processed');
  assert.deepEqual(f.messages.map(m => m.id), ['group', 'private', 'image', 'private-image', 'last']);
  assert.deepEqual(f.messages.slice(0, 2).map(({ kind, targetId, authorId, text }) => ({ kind, targetId, authorId, text })), [
    { kind: 'channel', targetId: 'channel-1', authorId: 'user-1', text: 'text group' },
    { kind: 'private', targetId: 'person-2', authorId: 'person-2', text: 'text private' },
  ]);
  assert.deepEqual(f.messages[2], { id: 'image', kind: 'channel', targetId: 'channel-1',
    authorId: 'user-1', text: '', isBot: false,
    images: [{ url: 'https://img.kookapp.cn/attachment.png', name: 'photo.png' }] });
  assert.deepEqual(f.messages[3], { id: 'private-image', kind: 'private', targetId: 'person-2',
    authorId: 'person-2', text: '', isBot: false,
    images: [{ url: 'https://img.kookapp.cn/private.png', name: undefined }] });
});

test('official SDK forwards explicit current bot mentions separately from all roles and textual tags', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  // Model the numeric identity returned by the real /user/me endpoint.
  f.clients[0]._me.id = '9001';
  const extra = mention => ({ author: { bot: false }, mention });
  f.sendEvent(1, event('direct-mention', { type: 9, content: '(met)9001(met) hello', extra: extra(['9001']) }));
  f.sendEvent(2, event('fake-tag', { type: 9, content: '(met)9001(met) hello', extra: extra([]) }));
  f.sendEvent(3, event('broadcast', { type: 9, content: '(met)all(met) hello',
    extra: { ...extra([]), mention_all: true, mention_here: true, mention_roles: [9001] } }));
  f.sendEvent(4, event('other-bot', { type: 9, content: '(met)9002(met) hello', extra: extra(['9002']) }));
  f.sendEvent(5, event('last'));
  await until(() => f.messages.some(m => m.id === 'last'), 'mention metadata frames');
  assert.equal(f.messages[0].mentionedBot, true);
  assert.equal(f.messages[0].botId, '9001');
  assert.equal(f.messages[0].text, '(met)9001(met) hello');
  for (const message of f.messages.slice(1)) assert.equal(message.mentionedBot, undefined, message.id);
});

test('official REST sends exact group and private endpoints and payloads', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const kind of ['channel', 'private']) {
    assert.deepEqual(await f.transport.send({ kind, targetId: `${kind}-target` }, 'hello'), { msg_id: 'sent-id', msg_timestamp: 123 });
  }
  assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(({ path, body }) => ({ path, body })), [
    { path: '/api/v3/message/create', body: { target_id: 'channel-target', type: 1, content: 'hello' } },
    { path: '/api/v3/direct-message/create', body: { target_id: 'private-target', type: 1, content: 'hello' } },
  ]);
});

test('official REST errors reject and HTTP 429 is never retried', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const text of ['api-error', 'http-error', 'bad-json', 'rate-limit']) {
    await assert.rejects(f.transport.send({ kind: 'channel', targetId: 'channel-1' }, text), /KOOK message delivery failed/);
    assert.equal(f.requests.filter(r => r.body?.content === text).length, 1, `${text} must issue one request`);
  }
});

test('stop aborts actual HTTP request and closes WebSocket without reconnect', { timeout: 5000 }, async t => {
  const f = await fixture(t, { requestTimeoutMs: 2000 });
  const rejected = assert.rejects(f.transport.send({ kind: 'private', targetId: 'person-2' }, 'hang'));
  await until(() => f.requests.some(r => r.body?.content === 'hang'), 'server receives pending POST');
  await f.transport.stop();
  await rejected;
  await until(() => f.connections.every(c => c.closed) && f.requests.find(r => r.body?.content === 'hang').closed, 'HTTP cancellation and socket close');
  const count = f.connections.length;
  await delay(100); // Longer than the configured reconnect delay.
  assert.equal(f.connections.length, count);
  assert.equal(f.clients[0].ws.currentState, 'IDLE');
  await assert.rejects(f.transport.send({ kind: 'channel', targetId: 'channel-1' }, 'after-stop'));
});

test('SDK resumes a disconnected WebSocket with session and last processed sequence', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.sendEvent(1, event('before-disconnect'));
  await until(() => f.messages.length === 1, 'first committed event');
  f.connections[0].socket.terminate();
  await until(() => f.connections.length === 2 && f.clients[0].ws.currentState === 'CONNECTED', 'SDK reconnect and RESUME_ACK');
  assert.equal(f.connections[1].query.get('resume'), '1');
  assert.equal(f.connections[1].query.get('sn'), '1');
  assert.equal(f.connections[1].query.get('session_id'), 'local-session');
  f.sendEvent(1, event('before-disconnect'));
  f.sendEvent(2, event('after-resume'));
  await until(() => f.messages.length === 2, 'post-resume event');
  assert.deepEqual(f.messages.map(m => m.id), ['before-disconnect', 'after-resume']);
  assert.equal(f.clients.length, 1, 'established connection recovery belongs to the SDK');
  assert.equal(f.requests.filter(r => r.path === '/api/v3/gateway/index').length, 1);
});

test('initial SDK connect failure is recovered with a fresh client', { timeout: 5000 }, async t => {
  const f = await fixture(t, { failFirstSelf: true });
  assert.equal(f.clients.length, 2);
  await assert.rejects(f.clients[0].connect(), /destroyed/i);
  assert.equal(f.connections.length, 1);
  assert.equal(f.requests.filter(r => r.path === '/api/v3/user/me').length, 2);
});

test('official REST timeout cancels a stalled local request', { timeout: 5000 }, async t => {
  const f = await fixture(t, { requestTimeoutMs: 100 });
  await assert.rejects(f.transport.send({ kind: 'channel', targetId: 'channel-1' }, 'hang'));
  await until(() => f.requests.some(r => r.body?.content === 'hang' && r.closed), 'timed-out request socket closes');
  assert.equal(f.requests.filter(r => r.body?.content === 'hang').length, 1);
});

const picture = { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 10]),
  mediaType: 'image/png', name: 'binary-picture.png' };

test('official SDK uploads exact binary multipart file and sends type 2 to both targets', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const kind of ['channel', 'private']) {
    assert.deepEqual(await f.transport.sendImage({ kind, targetId: `${kind}-target` }, picture),
      { msg_id: 'sent-id', msg_timestamp: 123 });
  }
  const posts = f.requests.filter(r => r.method === 'POST');
  assert.deepEqual(posts.map(r => r.path), ['/api/v3/asset/create', '/api/v3/message/create',
    '/api/v3/asset/create', '/api/v3/direct-message/create']);
  for (const upload of posts.filter(r => r.file)) {
    assert.match(upload.contentType, /^multipart\/form-data; boundary=/);
    assert.deepEqual(upload.file, { name: picture.name, mediaType: picture.mediaType, data: picture.data });
    assert.equal(upload.authorization, `Bot ${token}`);
  }
  assert.equal(posts.filter(r => r.file).length, 2);
  assert.deepEqual(posts.filter(r => r.body).map(r => r.body), [
    { target_id: 'channel-target', type: 2, content: 'https://img.kookapp.cn/assets/local-image.png' },
    { target_id: 'private-target', type: 2, content: 'https://img.kookapp.cn/assets/local-image.png' },
  ]);
});

test('official SDK never retries image upload or message failures', { timeout: 10000 }, async t => {
  for (const failure of ['rate-limit', 'api-error', 'http-error', 'bad-json']) {
    for (const stage of ['uploadFailure', 'imageMessageFailure']) {
      await t.test(`${stage}: ${failure}`, async t => {
        const f = await fixture(t, { [stage]: failure });
        await assert.rejects(f.transport.sendImage({ kind: 'channel', targetId: 'channel-1' }, picture),
          /KOOK message delivery failed/);
        await delay(30);
        assert.equal(f.requests.filter(r => r.path === '/api/v3/asset/create').length, 1);
        assert.equal(f.requests.filter(r => r.body?.type === 2).length, stage === 'uploadFailure' ? 0 : 1);
      });
    }
  }
});

test('untrusted uploaded asset URL cannot trigger an image message', { timeout: 5000 }, async t => {
  const f = await fixture(t, { uploadUrl: 'https://example.com/untrusted.png' });
  await assert.rejects(f.transport.sendImage({ kind: 'private', targetId: 'person-2' }, picture),
    error => error.code === 'IMAGE_URL');
  assert.equal(f.requests.filter(r => r.path === '/api/v3/asset/create').length, 1);
  assert.equal(f.requests.filter(r => r.body?.type === 2).length, 0);
});

test('already-cancelled image delivery issues no POST', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.transport.sendImage({ kind: 'private', targetId: 'person-2' }, picture, controller.signal));
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('cancellation and stop abort a pending image upload without sending or retrying', { timeout: 10000 }, async t => {
  for (const mode of ['signal', 'stop']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { uploadFailure: 'hang', requestTimeoutMs: 2000 });
      const controller = new AbortController();
      const rejected = assert.rejects(f.transport.sendImage({ kind: 'channel', targetId: 'channel-1' }, picture, controller.signal));
      await until(() => f.requests.some(r => r.path === '/api/v3/asset/create'), 'pending asset upload');
      if (mode === 'stop') await f.transport.stop();
      else controller.abort();
      await rejected;
      await until(() => f.requests.find(r => r.path === '/api/v3/asset/create').closed, 'asset request cancellation');
      await delay(30);
      assert.equal(f.requests.filter(r => r.path === '/api/v3/asset/create').length, 1);
      assert.equal(f.requests.filter(r => r.body?.type === 2).length, 0);
    });
  }
});

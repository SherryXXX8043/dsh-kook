import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KookTransport } from '../src/transport.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for transport state');
}
class Client extends EventEmitter {
  destroyed = 0;
  async connect() { this.emit('stateChange', 'CONNECTED'); }
  destroy() { this.destroyed++; }
}

test('failed authentication destroys client, retries without leaking SDK error', async t => {
  const clients = [], statuses = [];
  const transport = new KookTransport({ token: 'secret', retryBaseMs: 1,
    onStatus: value => statuses.push(value),
    clientFactory: config => {
      const client = new Client();
      clients.push(client);
      assert.equal(config.botToken, 'secret');
      assert.equal(config.autoReconnect, true);
      config.logger.error('secret gateway URL');
      if (clients.length === 1) client.connect = async () => { throw new Error('secret gateway URL'); };
      return client;
    },
  });
  t.after(() => transport.stop());
  transport.start();
  await until(() => statuses.includes('online'));
  assert.equal(clients.length, 2);
  assert.equal(clients[0].destroyed, 1);
  assert.equal(clients[0].listenerCount('event'), 0);
  assert.ok(!JSON.stringify(statuses).includes('secret'));
});

test('stop during pending client factory destroys late client without connecting', async () => {
  const created = deferred();
  const client = new Client();
  let requested = false, connected = false;
  client.connect = async () => { connected = true; };
  const transport = new KookTransport({ token: 'test', clientFactory: () => { requested = true; return created.promise; } });
  transport.start();
  await until(() => requested);
  const stopped = transport.stop();
  created.resolve(client);
  await stopped;
  assert.equal(client.destroyed, 1);
  assert.equal(connected, false);
  assert.equal(transport.client, undefined);
});

test('stop cancels pending connection and restart creates a fresh client', async () => {
  const connecting = deferred();
  const first = new Client();
  first.connect = () => connecting.promise;
  first.destroy = () => { first.destroyed++; connecting.reject(new Error('cancelled secret')); };
  const second = new Client();
  let count = 0;
  const transport = new KookTransport({ token: 'test', clientFactory: () => ++count === 1 ? first : second });
  transport.start();
  await until(() => transport.client === first);
  await transport.stop();
  assert.equal(first.destroyed, 1);
  assert.equal(first.listenerCount('event'), 0);
  transport.start();
  await until(() => transport.client === second);
  await transport.stop();
  assert.equal(second.destroyed, 1);
});

test('SDK reconnecting does not start a competing client or connection', async t => {
  const client = new Client();
  let connects = 0, factories = 0;
  client.connect = async () => { connects++; client.emit('stateChange', 'CONNECTED'); };
  const transport = new KookTransport({ token: 'test', retryBaseMs: 1,
    clientFactory: () => { factories++; return client; } });
  t.after(() => transport.stop());
  transport.start();
  await until(() => connects === 1);
  client.emit('close');
  client.emit('reconnecting', 'secret');
  await new Promise(resolve => setTimeout(resolve, 20));
  client.emit('stateChange', 'CONNECTED');
  assert.equal(connects, 1);
  assert.equal(factories, 1);
});

test('a second stop cancels a restart queued during pending shutdown', async () => {
  const created = deferred();
  let factories = 0;
  const client = new Client();
  const transport = new KookTransport({ token: 'test', retryBaseMs: 1,
    clientFactory: () => { factories++; return created.promise; } });
  transport.start();
  await until(() => factories === 1);
  const stopped = transport.stop();
  transport.start();
  const stoppedAgain = transport.stop();
  created.resolve(client);
  await Promise.all([stopped, stoppedAgain]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(transport.running, false);
  assert.equal(factories, 1);
  assert.equal(client.destroyed, 1);
});

test('stop aborts outstanding send and reports only a fixed error', async () => {
  const client = new Client();
  let signal;
  client.api = { request: (_url, _method, _data, _form, options) => {
    signal = options.signal;
    assert.equal(options.retryOnRateLimit, false);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ success: false, code: 499, message: 'secret' })));
  } };
  const transport = new KookTransport({ token: 'test', clientFactory: () => client });
  transport.start();
  await until(() => transport.client);
  const send = transport.send({ kind: 'private', targetId: '1' }, 'private text');
  const rejected = assert.rejects(send, { message: 'KOOK message delivery failed' });
  await transport.stop();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(transport.requests.size, 0);
});

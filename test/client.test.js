import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
const FiberState = { ACTIVE: 2 };
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('built client can read preset RPC through Cordis traced services', async () => {
  let client;
  vm.runInNewContext(await readFile(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { client = module.factory(() => ({})); } } },
  });
  const ctx = new Context();
  const remote = new Service(ctx, 'remote');
  const session = new Service(ctx, 'remote.session');
  const presets = new Service(ctx, 'remote.agentPresets');
  presets.list = async () => ({ ok: true, value: { presets: [{ id: 'standard' }] } });
  remote.session = session;
  remote.agentPresets = presets;
  let registration;
  ctx.provide('slots', {
    inject: (_name, callback) => callback(),
    register: options => { registration = options; },
  });
  ctx.provide('configForms', { get: () => ({}), describe: () => ({}) });
  ctx.provide('uiWorkspace', {});
  const fiber = ctx.plugin(client);
  await fiber;
  assert.equal(fiber.state, FiberState.ACTIVE);
  const props = registration.inject();
  const response = await props.remote.agentPresets.list();
  assert.equal(response.value.presets[0].id, 'standard');
  await fiber.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(t) {
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
  const registrations = [];
  class Slots extends Service {
    constructor(ctx) { super(ctx, 'slots'); }
    inject(_name, callback) { return callback(); }
    register(options, component) {
      return this.ctx.effect(() => {
        const entry = { ...options, component };
        registrations.push(entry);
        return () => { registrations.splice(registrations.indexOf(entry), 1); };
      });
    }
  }
  new Slots(ctx);
  const dictionaries = new Map();
  const calls = { register: [], dispose: [], bind: [] };
  let language = 'zh';
  const locale = {
    register(namespace, lang, dict) {
      calls.register.push([namespace, lang]);
      const key = `${namespace}:${lang}`;
      dictionaries.set(key, dict);
      return () => { calls.dispose.push(key); dictionaries.delete(key); };
    },
    bind(namespace) {
      calls.bind.push(namespace);
      return (key, params = {}) => (dictionaries.get(`${namespace}:${language}`)?.[key] ?? key)
        .replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
    },
    subscribe: () => () => {},
    getSnapshot: () => language,
  };
  ctx.provide('locale', locale);
  const form = {}, mirror = {}, workspace = {};
  ctx.provide('configForms', {
    get: namespace => { assert.equal(namespace, 'kook'); return form; },
    describe: () => mirror,
  });
  ctx.provide('uiWorkspace', workspace);
  const fiber = ctx.plugin(client);
  await fiber;
  t.after(() => fiber.dispose());
  return { fiber, registrations, form, mirror, workspace, locale, calls, dictionaries,
    setLanguage: value => { language = value; } };
}

test('settings entry injects current configuration and traced preset RPC without rendering', async t => {
  const f = await fixture(t);
  assert.equal(f.fiber.state, 2);
  const settings = f.registrations.find(entry => entry.name === 'settings.section' && entry.id === 'kook');
  assert.ok(settings, 'KOOK must appear as its own settings section');
  assert.equal(settings.order, 45);
  assert.equal(typeof settings.component, 'function');
  const props = settings.inject();
  assert.equal(props.form, f.form);
  assert.equal(props.mirror, f.mirror);
  assert.equal(props.workspace, f.workspace);
  assert.equal(props.locale, f.locale);
  assert.equal(typeof props.t, 'function');
  const response = await props.remote.agentPresets.list();
  assert.equal(response.value.presets[0].id, 'standard');
});

test('bundle configuration entry is a notice without duplicate form injection', async t => {
  const f = await fixture(t);
  const notice = f.registrations.find(entry => entry.name === 'plugins.bundle.config');
  assert.ok(notice);
  assert.equal(notice.key, 'dsh-kook');
  assert.equal(typeof notice.component, 'function');
  assert.equal(notice.inject, undefined);
  assert.equal(f.registrations.filter(entry => entry.name === 'settings.section').length, 1);
});

test('locale dictionaries and navigation callbacks bind dynamically and dispose with plugin', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls.register, [['kook-settings', 'zh'], ['kook-settings', 'en']]);
  assert.deepEqual(f.calls.bind, ['kook-settings']);
  const settings = f.registrations.find(entry => entry.name === 'settings.section');
  const props = settings.inject();
  assert.equal(settings.label(), 'KOOK');
  assert.equal(props.t('工作目录'), '工作目录');
  f.setLanguage('en');
  assert.equal(settings.label(), 'KOOK');
  assert.notEqual(props.t('工作目录'), '工作目录');
  assert.ok(props.t('已导入：{name}', { name: 'guide.txt' }).includes('guide.txt'));
  await f.fiber.dispose();
  assert.equal(f.registrations.length, 0);
  assert.equal(f.dictionaries.size, 0);
  assert.deepEqual(f.calls.dispose.sort(), ['kook-settings:en', 'kook-settings:zh']);
});

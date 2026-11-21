import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Pure configuration transformations only; no hooks, React renderer or DOM stand-in.
const source = await readFile(new URL('../client/index.js', import.meta.url), 'utf8');
const scope = { exports: {}, messages: {}, require: () => ({}) };
vm.runInNewContext(`${source}\nexports.__test = { toDraft, parseDraft, buildConfigOps };`, scope);
const { toDraft, parseDraft, buildConfigOps } = scope.exports.__test;
const plain = value => JSON.parse(JSON.stringify(value));
const draft = patch => ({ ...toDraft({ workspace: 'C:\\KOOK', allowedUsers: ['123'] }), ...patch });
const parse = patch => parseDraft(draft(patch));
const opFor = (ops, key) => ops.find(op => op.path[0] === key);

test('mention wakeup defaults on for existing settings and preserves explicit off through save operations', () => {
  assert.equal(toDraft({ workspace: 'C:\\KOOK', allowedUsers: ['123'] }).mentionWakeup, true);
  for (const enabled of [false, true]) {
    const values = parse({ mentionWakeup: enabled });
    assert.equal(values.mentionWakeup, enabled);
    assert.deepEqual(plain(opFor(buildConfigOps(values, 'keep'), 'mentionWakeup')),
      { op: 'set', path: ['mentionWakeup'], value: enabled });
  }
});

test('draft never echoes stored Token and retains stored settings including unavailable model ids', () => {
  const saved = { token: 'do-not-show-this-token', workspace: 'C:\\KOOK', allowedUsers: ['123', '456'], allowedChannels: ['789'],
    provider: 'offline-provider', model: 'temporarily-unlisted-model', agentPreset: 'custom-preset',
    knowledgeText: '  source text\nwith exact spacing  ', knowledgeName: 'notes.md', personality: 'custom persona', memoryLimit: 0 };
  const current = toDraft(saved);
  assert.equal(current.token, '');
  assert.ok(!JSON.stringify(current).includes(saved.token));
  assert.equal(current.allowedUsers, '123\n456');
  assert.equal(current.allowedChannels, '789');
  const values = parseDraft(current);
  for (const key of ['workspace', 'provider', 'model', 'agentPreset', 'knowledgeText', 'knowledgeName', 'personality', 'memoryLimit']) assert.equal(values[key], saved[key], key);
  assert.deepEqual(saved.allowedUsers, ['123', '456'], 'draft creation must not mutate saved arrays');
});

test('whitespace and comma separated user/channel ids are deduplicated in original order', () => {
  const values = parse({ allowedUsers: ' 123\n456,123，789\t456 ', allowedChannels: ' 77，88\n77 ',
    workspace: ' C:\\KOOK ', commandPrefix: ' /nemo ', token: ' replacement-token ' });
  assert.deepEqual(plain(values.allowedUsers), ['123', '456', '789']);
  assert.deepEqual(plain(values.allowedChannels), ['77', '88']);
  assert.equal(values.workspace, 'C:\\KOOK');
  assert.equal(values.commandPrefix, '/nemo');
  assert.equal(values.token, 'replacement-token');
});

test('Windows drive, UNC and POSIX absolute workspaces are accepted', () => {
  for (const workspace of ['C:\\KOOK', 'D:/KOOK workspace', '\\\\server\\share\\KOOK', '/home/user/kook']) assert.equal(parse({ workspace }).workspace, workspace);
});

test('all settings categories survive parse and operation construction together', () => {
  const values = parse({ allowPrivate: false, autoForwardChannels: true, pairingEnabled: true, ownerUserId: '456',
    provider: 'provider-b', model: 'model-b', agentPreset: 'preset-b', personality: 'Be concise',
    memoryLimit: '50', memoryHalfLifeMonths: '120', knowledgeLimit: '20', knowledgeText: 'raw\n\nknowledge ', knowledgeName: 'source.md',
    knowledgeFile: 'C:\\KOOK\\legacy.md', stateFile: '.state/routes.json', memoryFile: '.state/memory.json', tokenEnv: 'CUSTOM_KOOK_TOKEN' });
  const ops = buildConfigOps(values, 'keep');
  assert.equal(ops.length, Object.keys(values).length - 1);
  assert.equal(new Set(ops.map(op => op.path[0])).size, ops.length);
  for (const [key, value] of Object.entries(values)) {
    if (key === 'token') continue;
    const operation = opFor(ops, key);
    assert.equal(operation.op, 'set', key);
    assert.deepEqual(plain(operation.value), plain(value), key);
  }
  assert.equal(values.allowPrivate, false);
  assert.equal(values.memoryLimit, 50);
  assert.equal(values.memoryHalfLifeMonths, 120);
  assert.equal(values.knowledgeLimit, 20);
  assert.equal(values.knowledgeText, 'raw\n\nknowledge ', 'imported knowledge content remains exact');
});

test('blank Token leaves secret untouched while explicit disable/environment actions remain distinct', () => {
  const values = parse({ token: '   ' });
  assert.equal(opFor(buildConfigOps(values, 'keep'), 'token'), undefined);
  assert.deepEqual(plain(opFor(buildConfigOps(values, 'disable'), 'token')), { op: 'set', path: ['token'], value: '' });
  assert.deepEqual(plain(opFor(buildConfigOps(values, 'environment'), 'token')), { op: 'unset', path: ['token'] });
  for (const action of ['keep', 'disable', 'environment']) assert.deepEqual(plain(opFor(buildConfigOps({ ...values, token: 'new-secret' }, action), 'token')),
    { op: 'set', path: ['token'], value: 'new-secret' }, 'an explicit replacement takes precedence');
});

test('follow-default choices unset optional overrides but preserve intentionally empty content', () => {
  const values = parse({ provider: '', model: '', agentPreset: '', tokenEnv: '', personality: '', knowledgeText: '', knowledgeName: '', allowedChannels: '' });
  const ops = buildConfigOps(values, 'keep');
  for (const key of ['provider', 'model', 'agentPreset', 'tokenEnv']) assert.deepEqual(plain(opFor(ops, key)), { op: 'unset', path: [key] });
  for (const key of ['personality', 'knowledgeText', 'knowledgeName']) assert.deepEqual(plain(opFor(ops, key)), { op: 'set', path: [key], value: '' });
  assert.deepEqual(plain(opFor(ops, 'allowedChannels')), { op: 'set', path: ['allowedChannels'], value: [] });
});

test('model/provider and preset ids are retained without requiring a currently loaded catalog', () => {
  for (const [provider, model] of [['provider-a', 'model-a'], ['provider-b', 'model-b'], ['not-in-catalog', 'not-in-catalog']]) {
    const values = parse({ provider, model, agentPreset: 'not-in-catalog' });
    assert.equal(values.provider, provider); assert.equal(values.model, model);
    assert.equal(opFor(buildConfigOps(values, 'keep'), 'model').value, model);
  }
});

test('invalid required paths ids prefixes and incomplete model selections are rejected', () => {
  const invalid = [
    { workspace: '' }, { workspace: 'relative/path' }, { workspace: 'C:relative' },
    { allowedUsers: '' }, { allowedUsers: '123 not-an-id' }, { allowedChannels: 'abc' },
    { commandPrefix: '' }, { commandPrefix: '/two words' }, { stateFile: ' ' },
    { provider: 'provider', model: '' }, { provider: '', model: 'model' },
    { pairingEnabled: true, ownerUserId: '' }, { pairingEnabled: true, ownerUserId: 'not-numeric' },
  ];
  for (const patch of invalid) assert.throws(() => parse(patch), undefined, JSON.stringify(patch));
});

test('numeric configuration accepts limits and refuses fractions nonnumbers and out-of-range values', () => {
  assert.equal(parse({ memoryLimit: '0', knowledgeLimit: '0', memoryHalfLifeMonths: '1' }).memoryLimit, 0);
  for (const [key, values] of [
    ['memoryLimit', ['-1', '51', '1.5', 'NaN', 'Infinity']],
    ['memoryHalfLifeMonths', ['0', '121', '-1', '1.5', 'abc']],
    ['knowledgeLimit', ['-1', '21', '0.5', 'Infinity', 'abc']],
  ]) for (const value of values) assert.throws(() => parse({ [key]: value }), undefined, `${key}=${value}`);
});

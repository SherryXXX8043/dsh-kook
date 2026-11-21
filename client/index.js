// This source is the body of a DSH ModuleLoader factory; build with node scripts/build-client.mjs.
const React = require('react');
const { createElement: h, useState, useEffect, useCallback, useSyncExternalStore, useId } = React;
const fields = [
  ['token', 'Bot Token', 'password', '输入新 Token 以替换；留空保留现有 Token。已保存的 Token 不会回显。'],
  ['workspace', '工作目录', 'directory', '选择运行任务的目录。浏览的是 DSH 主机上的文件夹。'],
  ['allowedUsers', '允许的用户 ID', 'array', '必填；每行一个 ID，也可用逗号分隔。只有这些用户能调用机器人。'],
  ['allowedChannels', '允许的频道 ID', 'array', '每行一个 ID，也可用逗号分隔。留空禁用频道消息，私聊由下方开关控制。'],
  ['allowPrivate', '允许私聊', 'checkbox', '私聊仍受用户白名单限制。'],
      ['autoForwardChannels', '自动转发频道消息', 'checkbox', '开启后，白名单频道中的普通消息会自动进入 DSH；关闭时频道需使用命令前缀。'],
      ['pairingEnabled', '陌生人配对审批', 'checkbox', '陌生人私聊先收到配对码，主人批准后才能使用。'],
      ['ownerUserId', '主人 KOOK 用户 ID', 'text', '用于接收陌生人配对请求和批准通知。'],
      ['personality', '机器人性格设定', 'textarea', '描述长期人格、语气、边界和回答风格。'],
      ['memoryLimit', '每次使用的记忆条数', 'number', '按用户独立保存；数值越大，模型看到的记忆越多。'],
      ['memoryHalfLifeMonths', '记忆半衰期（月）', 'number', '记忆权重每经过这些月数衰减一半，数值越大衰退越慢。'],
      ['knowledgeFile', '知识库文件', 'knowledge', '选择 UTF-8 TXT 或 Markdown 文件，最大 1 MiB。导入的是内容快照，修改原文件后请重新导入。'],
      ['knowledgeLimit', '每次使用的知识条数', 'number', '根据用户问题做简单关键词检索。'],
  ['commandPrefix', '命令前缀', 'text', '例如 /dsh；不能包含空格。'],
  ['stateFile', '会话映射文件', 'storage', '默认自动保存到工作目录；通常无需修改。'],
  ['memoryFile', '记忆存储文件', 'storage', '默认自动保存到工作目录；通常无需修改。'],
  ['agentPreset', 'Agent 预设', 'select', '从 DSH 已配置的预设中选择。'],
  ['provider', '模型供应商', 'select', '跟随默认时，在会话创建或恢复时读取 DSH 默认模型及推理等级。'],
  ['model', '模型', 'select', '保存后的模型选择会用于新会话和恢复的旧会话；显式指定模型时使用该模型默认推理等级。'],
  ['tokenEnv', 'Token 环境变量（兼容）', 'text', '仅未填写 Bot Token 时使用。变量应在 DSH 启动前设置。'],
];
const defaults = { token: '', workspace: '', allowedUsers: [], allowedChannels: [], allowPrivate: true, autoForwardChannels: false, pairingEnabled: false, ownerUserId: '', personality: '', memoryFile: '.dsh-kook/memories.json', memoryLimit: 8, memoryHalfLifeMonths: 6, knowledgeFile: '', knowledgeText: '', knowledgeName: '', knowledgeLimit: 5, commandPrefix: '/dsh', stateFile: '.dsh-kook/routes.json', agentPreset: '', provider: '', model: '', tokenEnv: 'KOOK_BOT_TOKEN' };
function toDraft(value = {}) {
  return { knowledgeText: value.knowledgeText ?? '', knowledgeName: value.knowledgeName ?? '', ...Object.fromEntries(fields.map(([key, , type]) => {
    const v = key === 'token' ? '' : value[key] ?? defaults[key];
    return [key, type === 'array' ? v.join('\n') : v];
  })) };
}
function parseDraft(draft) {
  const value = Object.fromEntries(fields.map(([key, , type]) => [key,
    type === 'array' ? [...new Set(draft[key].split(/[\s,，]+/).filter(Boolean))] : type === 'checkbox' ? draft[key] : type === 'number' ? Number(draft[key]) : draft[key].trim(),
  ]));
  if (!value.workspace || !(/^[a-zA-Z]:[\\/]/.test(value.workspace) || value.workspace.startsWith('/') || /^\\\\[^\\]+\\[^\\]+/.test(value.workspace))) throw Error('工作目录必须是 DSH 主机上的绝对路径。');
  if (!value.allowedUsers.length) throw Error('请至少填写一个允许的用户 ID。');
  for (const key of ['allowedUsers', 'allowedChannels']) if (value[key].some(id => !/^\d+$/.test(id))) throw Error('用户和频道 ID 必须仅包含数字。');
  if (!value.commandPrefix || /\s/.test(value.commandPrefix)) throw Error('命令前缀不能为空或包含空格。');
  if (!value.stateFile) throw Error('请填写会话映射文件路径。');
  if (!!value.provider !== !!value.model) throw Error('供应商和模型名称必须一起填写或一起留空。');
  if (!Number.isSafeInteger(value.memoryLimit) || value.memoryLimit < 0 || !Number.isSafeInteger(value.memoryHalfLifeMonths) || value.memoryHalfLifeMonths < 1 || !Number.isSafeInteger(value.knowledgeLimit) || value.knowledgeLimit < 0) throw Error('记忆和知识库限制必须是有效整数。');
  if (value.pairingEnabled && !/^\d+$/.test(value.ownerUserId)) throw Error('启用配对审批时，请填写主人的 KOOK 用户 ID。');
  if (value.memoryLimit > 50 || value.memoryHalfLifeMonths > 120 || value.knowledgeLimit > 20) throw Error('记忆条数最多 50，半衰期最多 120 个月，知识条数最多 20。');
  return { ...value, knowledgeText: draft.knowledgeText, knowledgeName: draft.knowledgeName };
}
const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--border-color, #8886)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' };
function KookSettings({ form, mirror, remote, workspace }) {
  const mirrorSubscribe = useCallback(listener => mirror.subscribe(listener), [mirror]);
  const mirrorSnapshot = useCallback(() => mirror.getSnapshot(), [mirror]);
  const described = useSyncExternalStore(mirrorSubscribe, mirrorSnapshot, mirrorSnapshot);
  const secretSet = described.view?.namespaces.find(entry => entry.ns === 'kook')?.secrets?.some(secret => secret.path.length === 1 && secret.path[0] === 'token' && secret.set);
  const [tokenAction, setTokenAction] = useState('keep');
  const subscribe = useCallback(listener => form.subscribe(listener), [form]);
  const snapshot = useCallback(() => form.getSnapshot(), [form]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [draft, setDraft] = useState(() => toDraft(state.value));
  const [revision, setRevision] = useState(state.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  const [catalog, setCatalog] = useState({ groups: [], presets: [], loading: true, modelError: false, presetError: false });
  const [browser, setBrowser] = useState(null);
  const [importing, setImporting] = useState(false);
  const update = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); setNotice(''); };
  async function loadOptions() {
    setCatalog(previous => ({ ...previous, loading: true }));
    const [models, presets] = await Promise.allSettled([Promise.resolve().then(() => remote.session.modelCatalog()), Promise.resolve().then(() => remote.agentPresets?.list())]);
    const modelOk = models.status === 'fulfilled' && models.value?.ok;
    const presetOk = presets.status === 'fulfilled' && presets.value?.ok;
    setCatalog({ loading: false, groups: modelOk ? models.value.value.groups : [], presets: presetOk ? presets.value.value.presets : [],
      modelError: !modelOk || !!models.value?.value?.failures?.length, presetError: !presetOk });
  }
  useEffect(() => { void loadOptions(); }, [remote]);
  async function browse(key, path) {
    setBrowser({ key, loading: true, listing: null });
    try {
      const listing = await workspace.listDirectory(path);
      setBrowser(current => current?.key === key ? { key, loading: false, listing } : current);
    } catch { setBrowser(current => current?.key === key ? { key, loading: false, listing: null, error: true } : current); }
  }
  async function chooseDirectory(key) {
    if (globalThis.__DSH_DIRECTORY_PICKER__?.pick) {
      try { const path = await globalThis.__DSH_DIRECTORY_PICKER__.pick(); if (path !== null) acceptDirectory(key, path); }
      catch { setError('无法打开系统目录选择器，请使用目录浏览。'); await browse(key); }
    } else {
      try { const path = await workspace.pickDirectory(); if (path !== null) acceptDirectory(key, path); }
      catch { await browse(key); }
    }
  }
  function acceptDirectory(key, path) {
    if (key === 'workspace') update(key, path);
    else {
      const name = draft[key].split(/[\\/]/).pop() || (key === 'memoryFile' ? 'memories.json' : 'routes.json');
      update(key, path.replace(/[\\/]$/, '') + '/' + name);
    }
    setBrowser(null);
  }
  async function importKnowledge(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    if (file.size > 1024 * 1024 || !/\.(txt|md|markdown)$/i.test(file.name)) { setError('请选择不超过 1 MiB 的 UTF-8 TXT 或 Markdown 文件。'); return; }
    setImporting(true);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!text.trim() || text.includes('\0')) throw Error('invalid');
      setDraft(previous => ({ ...previous, knowledgeFile: '', knowledgeText: text, knowledgeName: file.name.split(/[\\/]/).pop() }));
      setDirty(true); setNotice('知识文件已读入，保存设置后生效。');
    } catch { setError('文件为空或不是有效的 UTF-8 文本，请转换编码后重试。'); }
    finally { setImporting(false); }
  }
  useEffect(() => {
    if (!dirty && !saving && state.status === 'ready') { setDraft(toDraft(state.value)); setRevision(state.revision); }
  }, [state, dirty, saving]);
  const reset = () => { setDraft(toDraft(state.value)); setRevision(state.revision); setDirty(false); setTokenAction('keep'); setError(''); setNotice(''); };
  async function save(event) {
    event.preventDefault();
    if (saving || importing || !state.writable || state.revision !== revision) return;
    setError(''); setNotice('');
    let values;
    try { values = parseDraft(draft); } catch (error) { setError(error.message); return; }
    setSaving(true);
    try {
      // Empty optional values remove the override, preserving Host/environment fallback semantics.
      const optional = new Set(['agentPreset', 'provider', 'model', 'tokenEnv']);
      const ops = Object.entries(values).filter(([key]) => key !== 'token').map(([key, value]) => optional.has(key) && value === ''
        ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value });
      if (values.token) ops.push({ op: 'set', path: ['token'], value: values.token });
      else if (tokenAction === 'disable') ops.push({ op: 'set', path: ['token'], value: '' });
      else if (tokenAction === 'environment') ops.push({ op: 'unset', path: ['token'] });
      const accepted = await form.mutate(ops, revision);
      if (!accepted) { setError('保存未被接受，可能是配置已被其他页面修改。请重新载入后检查并保存。'); return; }
      setDraft(previous => ({ ...previous, token: '' }));
      setDirty(false); setTokenAction('keep'); setNotice('设置已保存，KOOK 连接将应用新配置。');
    } catch { setError('保存失败，请检查 DSH 连接后重试。'); }
    finally { setSaving(false); }
  }
  if (state.status === 'loading') return h('p', { role: 'status' }, '正在读取 KOOK 设置…');
  if (state.status !== 'ready') return h('p', { role: 'alert' }, 'KOOK 配置尚不可用。请确认 KOOK 主机插件已启用且配置条目 ID 为 kook。');
  const disabled = saving || importing || !state.writable;
  function field([key, label, type, hint]) {
    const fieldId = `${id}-${key}`;
    const props = { id: fieldId, name: key, disabled, 'aria-describedby': `${fieldId}-hint`, onChange: event => { setDraft(previous => ({ ...previous, [key]: type === 'checkbox' ? event.target.checked : event.target.value })); setDirty(true); setNotice(''); } };
    let input;
    if (type === 'select') {
      const choices = key === 'provider' ? catalog.groups : key === 'model' ? (catalog.groups.find(group => group.id === draft.provider)?.models ?? []) : catalog.presets;
      const missing = draft[key] && !choices.some(item => item.id === draft[key]);
      input = h('select', { ...props, value: draft[key], style: inputStyle, disabled: disabled || catalog.loading || (key === 'model' && !draft.provider),
        onChange: event => {
          if (key === 'provider') { setDraft(previous => ({ ...previous, provider: event.target.value, model: '' })); setDirty(true); }
          else update(key, event.target.value);
        } }, h('option', { value: '' }, key === 'model' && draft.provider ? '请选择模型' : '跟随 DSH 默认'),
        missing && h('option', { value: draft[key], disabled: true }, '当前已保存选项（暂不可用）'),
        ...choices.map(item => h('option', { key: item.id, value: item.id, disabled: !!item.broken }, (item.name || item.id) + (item.broken ? '（不可用）' : ''))));
    } else if (type === 'directory' || type === 'storage') {
      input = h('div', null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('output', { id: fieldId, name: key, style: { ...inputStyle, overflowWrap: 'anywhere' } }, draft[key] || '尚未选择'),
          h('button', { type: 'button', disabled, onClick: () => chooseDirectory(key) }, type === 'storage' ? '选择保存目录' : '选择目录')),
        type === 'storage' && h('label', null, '文件名', h('input', { 'aria-label': label + '文件名', disabled, value: draft[key].split(/[\\/]/).pop(), onChange: event => {
          const name = event.target.value;
          if (/[\\/]/.test(name)) return;
          update(key, draft[key].replace(/[^\\/]*$/, name));
        }, style: inputStyle })),
        type === 'storage' && h('button', { type: 'button', disabled, onClick: () => update(key, defaults[key]) }, '恢复默认位置'));
    } else if (type === 'knowledge') {
      input = h('div', null, h('input', { id: fieldId, name: key, type: 'file', accept: '.txt,.md,.markdown,text/plain,text/markdown', disabled, onChange: importKnowledge }),
        h('p', { role: 'status' }, importing ? '正在读取…' : draft.knowledgeName ? '已导入：' + draft.knowledgeName : draft.knowledgeFile ? '使用先前配置的主机知识文件' : '尚未导入文件'),
        h('button', { type: 'button', disabled: disabled || (!draft.knowledgeText && !draft.knowledgeFile), onClick: () => {
          setDraft(previous => ({ ...previous, knowledgeFile: '', knowledgeName: '', knowledgeText: '' })); setDirty(true);
        } }, '移除知识库'));
    } else if (type === 'array' || type === 'textarea') input = h('textarea', { ...props, rows: type === 'textarea' ? 6 : 3, value: draft[key], style: inputStyle, spellCheck: false });
    else input = h('input', { ...props, type, ...(type === 'checkbox' ? { checked: draft[key], role: 'switch' } : { value: draft[key], style: inputStyle, autoComplete: key === 'token' ? 'new-password' : 'off', spellCheck: false }),
      ...(type === 'number' ? { min: key === 'memoryHalfLifeMonths' ? 1 : 0, max: key === 'memoryLimit' ? 50 : key === 'memoryHalfLifeMonths' ? 120 : 20, step: 1 } : {}) });
    return h('div', { key, style: { marginBottom: 18 } }, h('label', { htmlFor: fieldId, style: { display: 'block', fontWeight: 600, marginBottom: 5 } }, label), input,
      h('div', { id: `${fieldId}-hint`, style: { fontSize: 12, opacity: .72, marginTop: 5 } }, hint));
  }
  return h('form', { onSubmit: save, style: { maxWidth: 720, padding: '16px 0' } },
    h('h2', { style: { marginTop: 0 } }, 'KOOK 机器人'),
    h('p', null, 'DSH rc.5 本地适配版。保存设置会重连机器人并停止当前 KOOK 任务，请等本轮回答结束后再保存。工作目录指向运行 DSH 的主机。'),
    h('p', null, `图片：私聊可直接发图；频道关闭自动转发时，先发送 ${draft.commandPrefix || '/dsh'} /image <问题>，再在两分钟内发图。看图需选择支持图片的模型，单张最多 8 MiB，并受 DSH 限制。可要求机器人把工作目录内的图片发回当前聊天。`),
    !state.writable && h('p', { role: 'status' }, '当前 DSH 配置只读，无法保存修改。'),
    dirty && state.revision !== revision && h('p', { role: 'alert' }, '配置已在其他位置更新。请重新载入后再编辑。'),
    h('p', { role: 'status' }, secretSet ? '已配置 Token 覆盖值（包括主动停用时保存的空值）；内容不会回显。' : '未保存 Token 覆盖值；兼容使用主机环境变量。'),
    field(fields[0]),
    h('div', { style: { display: 'flex', gap: 12, marginBottom: 18 } },
      h('button', { type: 'button', disabled, onClick: () => { setTokenAction('disable'); setDraft(previous => ({ ...previous, token: '' })); setDirty(true); } }, '清除 Token 并停用连接'),
      h('button', { type: 'button', disabled, onClick: () => { setTokenAction('environment'); setDraft(previous => ({ ...previous, token: '' })); setDirty(true); } }, '改用环境变量')),
    tokenAction !== 'keep' && !draft.token && h('p', { role: 'status' }, tokenAction === 'disable' ? '保存后清除 Token 并停止连接。' : '保存后移除 Token 覆盖，使用环境变量。'),
    ...[
      ['连接与访问', ['workspace', 'allowedUsers', 'allowedChannels', 'allowPrivate', 'autoForwardChannels', 'commandPrefix']],
      ['模型与 Agent', ['provider', 'model', 'agentPreset']],
      ['人格与配对', ['personality', 'pairingEnabled', 'ownerUserId']],
      ['记忆与知识库', ['memoryLimit', 'memoryHalfLifeMonths', 'knowledgeFile', 'knowledgeLimit']],
    ].map(([title, keys]) => h('fieldset', { key: title, style: { border: '1px solid #8885', borderRadius: 8, padding: 16, marginBottom: 20 } },
      h('legend', null, title), ...keys.map(key => field(fields.find(item => item[0] === key))),
      title === '模型与 Agent' && h('div', null,
        catalog.loading && h('p', { role: 'status' }, '正在读取 DSH 可选项…'),
        catalog.modelError && h('p', { role: 'status' }, '部分模型列表不可用，请检查 DSH 模型配置后刷新。已保存的选择会保留。'),
        catalog.presetError && h('p', { role: 'status' }, '预设列表不可用，请检查 DSH 预设服务。'),
        h('button', { type: 'button', disabled: catalog.loading || disabled, onClick: loadOptions }, '刷新可选项')))),
    h('details', null, h('summary', { style: { cursor: 'pointer', marginBottom: 12 } }, '高级存储与兼容设置'),
      ...['stateFile', 'memoryFile', 'tokenEnv'].map(key => field(fields.find(item => item[0] === key)))),
    browser && h('section', { role: 'dialog', 'aria-modal': false, 'aria-label': '选择目录', style: { border: '2px solid #8888', padding: 16, borderRadius: 8 } },
      h('h3', null, '选择 DSH 主机目录'),
      browser.loading && h('p', { role: 'status' }, '正在加载目录…'),
      browser.error && h('p', { role: 'alert' }, '无法读取目录，请检查主机目录浏览服务或重试。'),
      h('button', { type: 'button', disabled: browser.loading, onClick: () => browse(browser.key) }, '主目录'),
      browser.listing && h('div', null,
        h('nav', { 'aria-label': '目录层级' }, ...browser.listing.crumbs.map(crumb => h('button', { type: 'button', key: crumb.path, onClick: () => browse(browser.key, crumb.path) }, crumb.name))),
        h('p', null, browser.listing.path),
        h('ul', { style: { maxHeight: 260, overflow: 'auto' } }, ...browser.listing.entries.map(entry => h('li', { key: entry.path },
          h('button', { type: 'button', onClick: () => browse(browser.key, entry.path) }, entry.name)))),
        browser.listing.truncated && h('p', null, '目录较多，列表仅显示部分内容。'),
        h('button', { type: 'button', onClick: () => acceptDirectory(browser.key, browser.listing.path) }, '使用此目录')),
      h('button', { type: 'button', onClick: () => setBrowser(null) }, '取消')),
    error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
    h('div', { style: { display: 'flex', gap: 12 } },
      h('button', { type: 'submit', disabled: disabled || !dirty || state.revision !== revision, style: { padding: '8px 16px', cursor: 'pointer' } }, saving ? '正在保存…' : '保存设置'),
      h('button', { type: 'button', disabled: saving || importing, onClick: reset, style: { padding: '8px 16px', cursor: 'pointer' } }, '重新载入 / 放弃修改')));
}
exports.inject = ['slots', 'configForms', 'remote', 'remote.session', 'remote.agentPresets', 'uiWorkspace'];
exports.apply = function apply(ctx) {
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-kook',
    inject: () => ({ form: ctx.configForms.get('kook'), mirror: ctx.configForms.describe(), remote: ctx.remote, workspace: ctx.uiWorkspace }),
  }, KookSettings));
};

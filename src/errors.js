import { randomUUID } from 'node:crypto';

const hints = {
  SESSION_CREATE: 'DSH 会话创建失败，请检查模型与 Agent 预设是否可用。',
  SESSION_RESUME: 'DSH 旧会话恢复失败。可先用 /status 获取会话 ID；需要新会话时发送 /new。',
  SESSION_OWNED: '该会话正在由 DSH 的其他组件管理，请先在本地完成或关闭任务；也可发送 /new 建立独立会话。',
  WORKSPACE_CHANGED: '工作目录已改变，旧会话不能迁移。请发送 /new，新消息会使用当前目录。',
  PRESET_CHANGED: 'Agent 预设已改变，请发送 /new，让新会话使用当前预设。',
  PRESET_UNAVAILABLE: 'DSH Agent 预设不可用，请在插件设置中重新选择可用预设。',
  MODEL_UNAVAILABLE: 'DSH 模型选择不可用，请检查默认模型，或在插件设置中重新选择供应商和模型。',
  WORKSPACE_ATTACH: '会话无法登记到 DSH 工作区，请检查工作目录与 DSH 存储服务。',
  ROUTE_SAVE: '无法保存会话映射，请检查存储目录是否可写、磁盘空间是否充足。',
  MEMORY_READ: '长期记忆读取失败，请检查记忆文件是否损坏。',
  MEMORY_SAVE: '本次消息未提交：长期记忆保存失败，请检查记忆目录权限和磁盘空间后重试。',
  PAIRING_SAVE: '无法保存配对审批，请检查记忆存储目录权限和磁盘空间。',
  MESSAGE_SUBMIT: '向 DSH 提交消息失败，请查看该会话当前状态后重试。',
  SESSION_LIMIT: '活动会话已达到上限，请释放不用的会话后重试。',
  REQUEST_FAILED: '请求未完成，请根据错误编号查看本地 KOOK 插件日志。',
};
export class KookError extends Error {
  constructor(code, cause) { super(hints[code] ?? hints.REQUEST_FAILED, { cause }); this.code = code; }
}
export async function step(code, operation) {
  try { return await operation(); }
  catch (error) { throw error instanceof KookError ? error : new KookError(code, error); }
}
export function reportFailure(logger, error) {
  const code = error instanceof KookError && hints[error.code] ? error.code : 'REQUEST_FAILED';
  const reference = randomUUID().slice(0, 8);
  // Only a fixed allowlist of machine error codes may leave the exception.
  // Never echo exception messages/stacks: they can contain tokens, prompts or host paths.
  const allowed = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBUSY', 'ETIMEDOUT', 'ECONNREFUSED']);
  let cause = error, systemCode = '';
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
    if (allowed.has(cause.code)) { systemCode = ` (${cause.code})`; break; }
  }
  logger.warn(`KOOK ${code}${systemCode} [${reference}]`);
  return `${hints[code]}\n错误：${code}${systemCode} · 编号：${reference}`;
}

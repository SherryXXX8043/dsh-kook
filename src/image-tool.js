import { KookError, reportFailure } from './errors.js';

/** One explicit publication tool, visible only to the live KOOK-routed Agent. */
export function createImageTool({ bridge, images, transport, logger }) {
  return {
    name: 'send_kook_image',
    description: 'Send one existing image file from the KOOK workspace to the current KOOK chat. Use when the user asks for an image or screenshot. Uploads the file and sends it as a picture; a Markdown path alone does not send an image. A failed or timed-out delivery may already have arrived; do not retry automatically.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Path to a PNG, JPEG, WebP or GIF inside the configured KOOK workspace; relative paths use that workspace. Maximum 8 MiB, also subject to DSH image limits.' },
    }, required: ['path'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: {
        status: { type: 'string', enum: ['sent', 'unconfirmed'] },
        message: { type: 'string' },
      }, required: ['status', 'message'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const destination = bridge.destinations.get(exec.agent?.id);
      const owns = [...bridge.handles.values()].some(handle => handle.agent === exec.agent && (!handle.isCurrent || handle.isCurrent()));
      if (!destination || !owns || bridge.stopped) throw new KookError('IMAGE_ROUTE');
      if (!args || typeof args.path !== 'string' || !args.path.trim()) throw new KookError('IMAGE_PATH');
      const signal = AbortSignal.any([exec.signal, bridge.lifetime.signal]);
      const input = await images.readLocal(args.path, signal);
      try {
        await bridge.queueDelivery(destination, () => {
          signal.throwIfAborted();
          if (bridge.destinations.get(exec.agent.id) !== destination ||
            ![...bridge.handles.values()].some(handle => handle.agent === exec.agent && (!handle.isCurrent || handle.isCurrent()))) throw new KookError('IMAGE_ROUTE');
          return transport.sendImage(destination, input, signal);
        });
        return { status: 'sent', message: '图片已发送到当前 KOOK 聊天。请勿重复发送同一张图。' };
      } catch (error) {
        const message = reportFailure(logger, new KookError('IMAGE_SEND', error));
        // Acknowledgement loss is ambiguous. Do not turn this into an invitation to retry a tool failure.
        return { status: 'unconfirmed', message };
      }
    },
  };
}

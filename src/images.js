import { KookError } from './errors.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export function parseImageCard(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) return;
  try {
    const cards = JSON.parse(content);
    if (!Array.isArray(cards) || cards.length > 10) return;
    const images = [], texts = [];
    let modules = 0;
    const text = element => {
      if (element?.type === 'plain-text' || element?.type === 'kmarkdown') {
        if (typeof element.content === 'string') texts.push(element.content);
      }
    };
    const image = element => {
      if (element?.type === 'image' && typeof element.src === 'string') {
        images.push({ url: element.src, name: typeof element.title === 'string' ? element.title : undefined });
      }
    };
    for (const card of cards) {
      if (card?.type !== 'card' || !Array.isArray(card.modules)) return;
      for (const module of card.modules) {
        if (++modules > 100) return;
        if (['container', 'image-group'].includes(module?.type) && Array.isArray(module.elements)) {
          for (const element of module.elements) {
            image(element);
            if (images.length > 20) throw new Error('Image card exceeds supported count');
          }
        } else if (module?.type === 'section') {
          text(module.text);
          image(module.accessory);
        } else if (module?.type === 'header') text(module.text);
        if (images.length > 20) throw new Error('Image card exceeds supported count');
      }
    }
    return images.length ? { text: texts.join('\n'), images } : undefined;
  } catch { return; }
}

// KOOK's current and legacy image CDNs. Never fetch arbitrary user URLs or follow redirects.
const imageHosts = new Set(['img.kookapp.cn', 'img.kaiheila.cn']);
export function kookImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !imageHosts.has(url.hostname) || url.port || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new KookError('IMAGE_URL'); }
}
export function imageMediaType(data) {
  const b = Buffer.from(data);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new KookError('IMAGE_FORMAT');
}
function imageName(name, mediaType) {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mediaType];
  const safe = typeof name === 'string' ? name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : '';
  return safe || `kook-image.${extension}`;
}

export class KookImages {
  constructor({ attachments, fs, workspace, signal, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    Object.assign(this, { attachments, fs, workspace, signal, fetchImpl, timeoutMs });
    this.active = 0;
  }
  limits() {
    if (!this.attachments) throw new KookError('IMAGE_UNAVAILABLE');
    const limits = this.attachments.imageLimits;
    return { bytes: Math.min(MAX_IMAGE_BYTES, limits.maxImageBytes, limits.maxMessageImageBytes),
      count: limits.maxImagesPerMessage, total: limits.maxMessageImageBytes };
  }
  async download(image, signal, maxBytes) {
    const url = kookImageUrl(image.url);
    let response;
    try {
      response = await this.fetchImpl(url, { signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body) throw new KookError('IMAGE_DOWNLOAD');
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) throw new KookError('IMAGE_TOO_LARGE');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        size += chunk.byteLength;
        if (size > maxBytes) throw new KookError('IMAGE_TOO_LARGE');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const mediaType = imageMediaType(data);
      const declaredType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== mediaType) throw new KookError('IMAGE_FORMAT');
      return { data, mediaType, name: imageName(image.name, mediaType) };
    } catch (error) {
      // Cancel bodies rejected before reading (e.g. oversized Content-Length).
      try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* already consumed */ }
      throw error instanceof KookError ? error : new KookError('IMAGE_DOWNLOAD', error);
    }
  }
  async admit(images, externalSignal) {
    const limits = this.limits();
    if (!Array.isArray(images) || images.length > limits.count) throw new KookError('IMAGE_TOO_LARGE');
    if (this.active >= 4) throw new KookError('IMAGE_BUSY');
    this.active++;
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...[this.signal, externalSignal].filter(Boolean)]);
    try {
      const inputs = [];
      let total = 0;
      for (const image of images) {
        signal.throwIfAborted();
        const input = await this.download(image, signal, Math.min(limits.bytes, limits.total - total));
        total += input.data.length;
        inputs.push(input);
      }
      signal.throwIfAborted();
      // The Host fully decodes and validates the whole batch before storing any image.
      const refs = await this.attachments.saveImages(inputs);
      signal.throwIfAborted();
      return refs.map(attachment => ({ type: 'image', attachment }));
    } catch (error) {
      if (error instanceof KookError) throw error;
      throw new KookError(this.attachments.isAttachmentError?.(error) ? 'IMAGE_FORMAT' : 'IMAGE_DOWNLOAD', error);
    } finally { this.active--; }
  }
  async readLocal(path, signal) {
    const limits = this.limits();
    if (!this.fs || typeof path !== 'string' || !path.trim()) throw new KookError('IMAGE_PATH');
    try {
      signal?.throwIfAborted();
      const root = await this.fs.resolve(this.workspace, { signal });
      const target = await this.fs.resolve(path, { cwd: this.workspace, signal });
      if (!this.fs.contains(root, target)) throw new KookError('IMAGE_PATH');
      const data = await this.fs.readBytes(target, signal, limits.bytes);
      const mediaType = imageMediaType(data);
      const input = { data, mediaType, name: imageName(target.displayPath, mediaType) };
      await this.attachments.validateImage(input);
      signal?.throwIfAborted();
      return input;
    } catch (error) {
      if (error instanceof KookError) throw error;
      throw new KookError(error?.code === 'FS_TOO_LARGE' ? 'IMAGE_TOO_LARGE' : 'IMAGE_PATH', error);
    }
  }
}

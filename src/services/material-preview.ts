import { ProjectError } from './errors.ts';

export function previewText(bytes: Buffer): string {
  if (bytes.length > 1048576)
    throw new ProjectError('MATERIAL_PREVIEW_BUDGET', '材料超过1MiB预览预算，请下载完整文件');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectError('MATERIAL_NOT_UTF8', '此材料不是UTF-8文本，请下载原件');
  }
}

export function previewImage(bytes: Buffer) {
  if (bytes.length > 8 * 1024 * 1024)
    throw new ProjectError('MATERIAL_PREVIEW_BUDGET', '图片超过8MiB预览预算，请下载完整原件');
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
        ? 'image/gif'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : null;
  if (!type) throw new ProjectError('MATERIAL_NOT_IMAGE', '未识别为可安全预览的图片，请下载原件');
  return {
    bytes: new Uint8Array(bytes),
    headers: {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  };
}

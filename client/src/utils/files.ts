import { LIMITS } from '@lanshare/shared';

/** Create a small JPEG preview of an image. Returns undefined if the image cannot be decoded or is too big to embed. */
export async function makeThumbnail(file: File, maxDim = 240): Promise<string | undefined> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.size > 40 * 1024 * 1024) return undefined;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    for (const q of [0.72, 0.55, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= LIMITS.thumbMax && url.startsWith('data:image/jpeg;base64,')) return url;
    }
  } catch {
    /* undecodable image: no preview */
  }
  return undefined;
}

/** Hand a Blob to the browser's download manager. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}

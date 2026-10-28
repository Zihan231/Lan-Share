import { sha256, toHex } from '@lanshare/shared';

const BLOCK = 4 * 1024 * 1024;

/** Streaming SHA-256 of a Blob/File. Reads 4 MiB at a time so large files are never fully in memory. */
export async function hashBlob(blob: Blob, onProgress?: (fraction: number) => void, shouldAbort?: () => boolean): Promise<string> {
  const h = sha256.create();
  for (let off = 0; off < blob.size; off += BLOCK) {
    if (shouldAbort?.()) throw new Error('aborted');
    h.update(new Uint8Array(await blob.slice(off, Math.min(off + BLOCK, blob.size)).arrayBuffer()));
    onProgress?.(Math.min(1, (off + BLOCK) / blob.size));
    // let the event loop breathe when running on the main thread
    if ((off / BLOCK) % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  onProgress?.(1);
  return toHex(h.digest());
}

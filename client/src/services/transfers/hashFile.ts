import { randomId } from '@lanshare/shared';
import { hashBlob } from './hashBlob';

let worker: Worker | null = null;
const waiting = new Map<string, { progress?: (p: number) => void; ok: (s: string) => void; err: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('../../workers/hash.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ id: string; progress?: number; sha256?: string; error?: string }>) => {
      const w = waiting.get(ev.data.id);
      if (!w) return;
      if (ev.data.progress !== undefined) w.progress?.(ev.data.progress);
      else if (ev.data.sha256) {
        waiting.delete(ev.data.id);
        w.ok(ev.data.sha256);
      } else if (ev.data.error) {
        waiting.delete(ev.data.id);
        w.err(new Error(ev.data.error));
      }
    };
    worker.onerror = () => {
      for (const w of waiting.values()) w.err(new Error('hash worker crashed'));
      waiting.clear();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

/** SHA-256 of a file, computed off the main thread when possible. */
export function hashFile(file: Blob, onProgress?: (p: number) => void): Promise<string> {
  const w = getWorker();
  if (!w) return hashBlob(file, onProgress);
  const id = randomId();
  return new Promise((ok, err) => {
    waiting.set(id, { progress: onProgress, ok, err });
    w.postMessage({ id, file });
  }).catch(() => hashBlob(file, onProgress)) as Promise<string>;
}

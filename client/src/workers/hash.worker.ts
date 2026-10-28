import { hashBlob } from '../services/transfers/hashBlob';

self.onmessage = async (ev: MessageEvent<{ id: string; file: Blob }>) => {
  const { id, file } = ev.data;
  try {
    const sha = await hashBlob(file, (p) => (self as unknown as Worker).postMessage({ id, progress: p }));
    (self as unknown as Worker).postMessage({ id, sha256: sha });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};

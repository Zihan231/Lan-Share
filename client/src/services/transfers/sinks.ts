import { SEGMENT_SIZE } from '../storage/db';

/**
 * Where downloaded bytes go. A sink is created at click time (a user gesture is required for the
 * save-file picker) and handed to the TransferManager.
 */
export interface Sink {
  readonly kind: 'disk' | 'store' | 'memory';
  write(chunk: Uint8Array): Promise<void>;
  /** The transfer was verified; finalise the output. */
  commit(): Promise<void>;
  /** The transfer failed or was cancelled; discard everything written. */
  abort(): Promise<void>;
  /** Start over from byte 0 (used when retrying from another source). */
  reset(): Promise<void>;
}

/** Streams straight to a file chosen by the user (File System Access API). Nothing is held in RAM. */
export class DiskSink implements Sink {
  readonly kind = 'disk' as const;
  private w: FileSystemWritableFileStream | null = null;

  constructor(private readonly handle: FileSystemFileHandle) {}

  private async writer() {
    return (this.w ??= await this.handle.createWritable());
  }
  async write(chunk: Uint8Array) {
    await (await this.writer()).write(chunk as unknown as BufferSource);
  }
  async commit() {
    await (await this.writer()).close();
    this.w = null;
  }
  async abort() {
    try {
      await this.w?.abort();
    } catch {
      /* ignore */
    }
    this.w = null;
    try {
      await (this.handle as FileSystemFileHandle & { remove?: () => Promise<void> }).remove?.();
    } catch {
      /* ignore */
    }
  }
  async reset() {
    try {
      await this.w?.abort();
    } catch {
      /* ignore */
    }
    this.w = null;
  }
}

export interface SegmentStore {
  putSegment(fileId: string, index: number, blob: Blob): Promise<void>;
  deleteSegments(fileId: string): Promise<void>;
}

/**
 * Stores the download in IndexedDB in ~4 MiB segments. Used for verified replicas and as the fallback where the
 * save-file picker is unavailable (e.g. Firefox/Safari, or plain-HTTP origins). Limited by the browser's storage quota.
 */
export class StoreSink implements Sink {
  readonly kind = 'store' as const;
  private parts: Uint8Array[] = [];
  private buffered = 0;
  private index = 0;
  segments = 0;

  constructor(
    private readonly store: SegmentStore,
    private readonly fileId: string,
    private readonly segmentSize = SEGMENT_SIZE,
  ) {}

  private async flush() {
    if (!this.buffered) return;
    const blob = new Blob(this.parts as BlobPart[]);
    this.parts = [];
    this.buffered = 0;
    await this.store.putSegment(this.fileId, this.index++, blob);
  }
  async write(chunk: Uint8Array) {
    this.parts.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered >= this.segmentSize) await this.flush();
  }
  async commit() {
    await this.flush();
    this.segments = this.index;
  }
  async abort() {
    this.parts = [];
    this.buffered = 0;
    this.index = 0;
    await this.store.deleteSegments(this.fileId);
  }
  async reset() {
    await this.abort();
  }
}

export class MemorySink implements Sink {
  readonly kind = 'memory' as const;
  chunks: Uint8Array[] = [];
  committed = false;
  aborted = false;
  async write(c: Uint8Array) {
    this.chunks.push(c);
  }
  async commit() {
    this.committed = true;
  }
  async abort() {
    this.aborted = true;
    this.chunks = [];
  }
  async reset() {
    this.chunks = [];
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

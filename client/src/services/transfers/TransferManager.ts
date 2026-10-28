import {
  LIMITS,
  decodeFrame,
  encodeFrame,
  isId,
  randomId,
  sha256,
  toHex,
  type FileMeta,
  type PeerMsg,
  type XferReceiverMsg,
  type XferSenderMsg,
} from '@lanshare/shared';
import type { TransferView } from '../../types';
import { drain, waitOpen, type LinkChannel } from '../webrtc/channel';
import { SpeedMeter, etaSeconds } from './speed';
import type { Sink } from './sinks';

export interface TransferSettings {
  maxUploads: number;
  maxDownloads: number;
  chunkSize: number;
  /** Max bytes the sender may have in flight beyond what the receiver has persisted. */
  windowBytes: number;
  /** Largest file accepted/served (bytes). */
  maxFileSize: number;
}

export interface TransferHost {
  sendCtl(peerId: string, msg: PeerMsg): boolean;
  openChannel(peerId: string, transferId: string): LinkChannel | null;
  getMeta(fileId: string): FileMeta | undefined;
  /** A readable source for a file this device can serve right now (original File, or verified replica). */
  getSource(fileId: string): Promise<Blob | null>;
  /** Connected peers that announced a complete copy, in preference order. */
  holders(fileId: string): string[];
  settings(): TransferSettings;
  onChange(view: TransferView): void;
  now?(): number;
}

export interface DownloadRequest {
  fileId: string;
  sink: Sink;
  /** The user opted to keep this file and serve it to others. */
  keep: boolean;
}

export interface DownloadResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  /** peer the verified bytes came from */
  from?: string;
}

class SourceFailure extends Error {
  constructor(
    msg: string,
    readonly retryNext = true,
  ) {
    super(msg);
  }
}
class FatalFailure extends Error {}

const SEND_HIGH_WATER = 1024 * 1024;
const READ_BLOCK = 1024 * 1024;
const ACK_EVERY = 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;
const QUEUED_TIMEOUT = 15 * 60_000;
const STALL_TIMEOUT = 30_000;
const MAX_REQUESTS_PER_MIN = 40;
const MAX_UPLOADS_PER_PEER = 4;

interface DownloadJob {
  id: string;
  req: DownloadRequest;
  view: TransferView;
  speed: SpeedMeter;
  tried: Set<string>;
  cancelled: boolean;
  abortAttempt: ((e: Error) => void) | null;
  currentTransferId: string | null;
  resolve: (r: DownloadResult) => void;
  lastEmit: number;
}

interface UploadJob {
  id: string; // transferId
  peerId: string;
  fileId: string;
  view: TransferView;
  speed: SpeedMeter;
  source: Blob;
  ch: LinkChannel | null;
  cancelled: boolean;
  acked: number;
  ackWaiters: Array<() => void>;
  abort: (reason: string) => void;
  lastEmit: number;
}

interface PendingIn {
  job: DownloadJob;
  peerId: string;
  onChannel(ch: LinkChannel): void;
  onReject(reason: string): void;
  onQueued(): void;
}

/**
 * Chunked, flow-controlled, integrity-checked file transfer over per-transfer DataChannels.
 *
 * Receiver (downloader): sends `file-request` on the control channel; the sender opens `xfer:<id>`; frames are
 * [seq u32][payload]. The receiver validates `start` against the signed metadata (size, chunk geometry), checks
 * sequence numbers and sizes, streams to a Sink, hashes incrementally (SHA-256) and verifies against the uploader-signed
 * checksum before the Sink is committed. It acknowledges persisted bytes so the sender never has more than `windowBytes`
 * unacknowledged, bounding memory on both sides. If a source fails, the next advertised holder is tried (from byte 0:
 * transfers are NOT resumable).
 */
export class TransferManager {
  private downloads = new Map<string, DownloadJob>();
  private downloadQueue: DownloadJob[] = [];
  private pendingIn = new Map<string, PendingIn>();
  private uploads = new Map<string, UploadJob>();
  private uploadQueue: UploadJob[] = [];
  private requestLog = new Map<string, number[]>();
  private activeDownloads = 0;
  private activeUploads = 0;

  constructor(private readonly host: TransferHost) {}

  private now() {
    return this.host.now?.() ?? Date.now();
  }

  // ============================================================================================
  // Downloading
  // ============================================================================================

  /** Queue a download. Resolves when the transfer ends (verified, failed or cancelled). */
  download(req: DownloadRequest): { id: string; done: Promise<DownloadResult> } {
    const meta = this.host.getMeta(req.fileId);
    const id = randomId();
    let resolve!: (r: DownloadResult) => void;
    const done = new Promise<DownloadResult>((r) => (resolve = r));
    const view: TransferView = {
      id,
      fileId: req.fileId,
      direction: 'down',
      peerId: '',
      name: meta?.name ?? 'file',
      size: meta?.size ?? 0,
      bytes: 0,
      speed: 0,
      eta: null,
      state: 'queued',
      startedAt: this.now(),
      keep: req.keep,
    };
    const job: DownloadJob = { id, req, view, speed: new SpeedMeter(), tried: new Set(), cancelled: false, abortAttempt: null, currentTransferId: null, resolve, lastEmit: 0 };
    this.downloads.set(id, job);
    if (!meta) {
      this.finishDownload(job, { ok: false, error: 'Unknown file' }, 'failed');
      return { id, done };
    }
    if (meta.size > this.host.settings().maxFileSize) {
      this.finishDownload(job, { ok: false, error: 'File exceeds your configured size limit' }, 'failed');
      return { id, done };
    }
    this.downloadQueue.push(job);
    this.emit(job.view, true);
    this.pumpDownloads();
    return { id, done };
  }

  private pumpDownloads() {
    while (this.activeDownloads < this.host.settings().maxDownloads && this.downloadQueue.length) {
      const job = this.downloadQueue.shift()!;
      if (job.cancelled) continue;
      this.activeDownloads++;
      void this.runDownload(job).finally(() => {
        this.activeDownloads--;
        this.pumpDownloads();
      });
    }
  }

  private async runDownload(job: DownloadJob) {
    const meta = this.host.getMeta(job.req.fileId);
    if (!meta) return this.finishDownload(job, { ok: false, error: 'Unknown file' }, 'failed');
    let lastError = 'No online peer has a copy of this file.';
    let first = true;
    for (;;) {
      if (job.cancelled) return;
      const source = this.host.holders(job.req.fileId).find((p) => !job.tried.has(p));
      if (!source) break;
      job.tried.add(source);
      try {
        if (!first) await job.req.sink.reset();
        first = false;
        job.view.bytes = 0;
        job.speed = new SpeedMeter();
        await this.attempt(job, meta, source);
        return this.finishDownload(job, { ok: true, from: source }, 'done');
      } catch (e) {
        if (job.cancelled) return;
        if (e instanceof FatalFailure) return this.finishDownload(job, { ok: false, error: e.message }, 'failed');
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    this.finishDownload(job, { ok: false, error: lastError }, 'failed');
  }

  private finishDownload(job: DownloadJob, result: DownloadResult, state: 'done' | 'failed' | 'cancelled') {
    if (!this.downloads.has(job.id)) return;
    this.downloads.delete(job.id);
    job.view.state = state;
    job.view.error = result.error;
    if (state === 'done') job.view.bytes = job.view.size;
    job.view.speed = 0;
    job.view.eta = 0;
    this.emit(job.view, true);
    if (state !== 'done') void job.req.sink.abort().catch(() => undefined);
    job.resolve(result);
  }

  private attempt(job: DownloadJob, meta: FileMeta, peerId: string): Promise<void> {
    const transferId = randomId();
    const hasher = sha256.create();
    job.view.peerId = peerId;
    job.view.state = 'requesting';
    this.emit(job.view, true);
    job.currentTransferId = transferId;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ch: LinkChannel | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let started = false;
      let chunkSize = 0;
      let totalChunks = 0;
      let expectSeq = 0;
      let received = 0;
      let persisted = 0;
      let lastAck = 0;
      let ackEvery = ACK_EVERY;
      let chain: Promise<void> = Promise.resolve();
      let ended = false;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.pendingIn.delete(transferId);
        job.abortAttempt = null;
        job.currentTransferId = null;
        if (ch) {
          ch.onmessage = null;
          ch.onclose = null;
          ch.onerror = null;
        }
      };
      const fail = (e: Error, notifyPeer = true) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (notifyPeer) {
          try {
            if (ch?.readyState === 'open') ch.send(JSON.stringify({ t: 'cancel' } satisfies XferReceiverMsg));
          } catch {
            /* closed */
          }
          this.host.sendCtl(peerId, { t: 'xfer-cancel', transferId });
        }
        try {
          ch?.close();
        } catch {
          /* closed */
        }
        reject(e);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ch?.close();
        } catch {
          /* closed */
        }
        resolve();
      };
      const arm = (ms: number, msg: string) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fail(new SourceFailure(msg)), ms);
      };
      job.abortAttempt = (e) => fail(e);

      const sendAck = () => {
        if (ch?.readyState === 'open') {
          try {
            ch.send(JSON.stringify({ t: 'ack', bytes: persisted } satisfies XferReceiverMsg));
            lastAck = persisted;
          } catch {
            /* closed */
          }
        }
      };

      const onChunk = (data: ArrayBuffer | ArrayBufferView) => {
        if (!started || ended) return fail(new SourceFailure('Unexpected data'));
        const frame = decodeFrame(data instanceof ArrayBuffer ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (!frame) return fail(new SourceFailure('Malformed frame'));
        const { seq, payload } = frame;
        const expectedLen = Math.min(chunkSize, meta.size - received);
        if (seq !== expectSeq || seq >= totalChunks) return fail(new SourceFailure('Chunk out of sequence'));
        if (payload.length !== expectedLen) return fail(new SourceFailure('Chunk has wrong size'));
        expectSeq++;
        received += payload.length;
        hasher.update(payload);
        arm(STALL_TIMEOUT, 'Transfer stalled');
        chain = chain.then(async () => {
          if (settled) return;
          try {
            await job.req.sink.write(payload);
          } catch (e) {
            return fail(new FatalFailure(describeStorageError(e)));
          }
          persisted += payload.length;
          job.view.bytes = persisted;
          this.progress(job.view, job.speed, persisted);
          if (persisted - lastAck >= ackEvery) sendAck();
        });
      };

      const onEnd = (m: Extract<XferSenderMsg, { t: 'end' }>) => {
        if (!started || ended) return fail(new SourceFailure('Unexpected end'));
        ended = true;
        if (m.chunks !== totalChunks || m.size !== meta.size || expectSeq !== totalChunks || received !== meta.size) {
          return fail(new SourceFailure('Transfer ended with the wrong size'));
        }
        chain = chain.then(async () => {
          if (settled) return;
          job.view.state = 'verifying';
          this.emit(job.view, true);
          const digest = toHex(hasher.digest());
          if (digest !== meta.sha256) return fail(new SourceFailure('Integrity check failed (SHA-256 mismatch); trying another source'));
          try {
            await job.req.sink.commit();
          } catch (e) {
            return fail(new FatalFailure(describeStorageError(e)));
          }
          sendAck();
          succeed();
        });
      };

      const onText = (text: string) => {
        let m: XferSenderMsg;
        try {
          m = JSON.parse(text);
        } catch {
          return fail(new SourceFailure('Malformed message'));
        }
        if (m.t === 'start') {
          const ok =
            !started &&
            m.fileId === meta.fileId &&
            m.size === meta.size &&
            Number.isInteger(m.chunkSize) &&
            m.chunkSize >= LIMITS.chunkMin &&
            m.chunkSize <= LIMITS.chunkMax &&
            m.chunks === Math.ceil(meta.size / m.chunkSize);
          if (!ok) return fail(new SourceFailure('Sender metadata does not match the file'));
          started = true;
          // acknowledge often enough that the sender's window can never stall (window/4, between one chunk and 1 MiB)
          const win = Number.isFinite(m.window) && m.window > 0 ? m.window : ACK_EVERY * 4;
          ackEvery = Math.max(m.chunkSize, Math.min(ACK_EVERY, Math.floor(win / 4)));
          chunkSize = m.chunkSize;
          totalChunks = m.chunks;
          job.view.state = 'receiving';
          job.view.startedAt = this.now();
          this.emit(job.view, true);
          arm(STALL_TIMEOUT, 'Transfer stalled');
        } else if (m.t === 'end') onEnd(m);
        else if (m.t === 'error') fail(new SourceFailure(`Peer reported: ${String(m.reason).slice(0, 80)}`), false);
      };

      const entry: PendingIn = {
        job,
        peerId,
        onChannel: (c) => {
          ch = c;
          c.binaryType = 'arraybuffer';
          c.onmessage = (ev) => (typeof ev.data === 'string' ? onText(ev.data) : onChunk(ev.data));
          c.onclose = () => {
            if (!settled && !(ended && persisted >= meta.size)) fail(new SourceFailure('Connection to peer closed during transfer'), false);
          };
          c.onerror = () => fail(new SourceFailure('Channel error'), false);
          arm(STALL_TIMEOUT, 'Sender did not start the transfer');
        },
        onReject: (reason) => fail(new SourceFailure(reason === 'busy' ? 'Peer is busy' : reason === 'rate-limited' ? 'Too many requests' : 'Peer no longer has this file'), false),
        onQueued: () => arm(QUEUED_TIMEOUT, 'Waiting in the sender queue timed out'),
      };
      this.pendingIn.set(transferId, entry);
      arm(REQUEST_TIMEOUT, 'Peer did not respond');
      if (!this.host.sendCtl(peerId, { t: 'file-request', transferId, fileId: meta.fileId })) fail(new SourceFailure('Peer is not connected'), false);
    });
  }

  /** An `xfer:<id>` channel opened by a remote sender. */
  handleIncomingChannel(peerId: string, ch: LinkChannel, transferId: string) {
    const pending = this.pendingIn.get(transferId);
    if (!pending || pending.peerId !== peerId) {
      try {
        ch.close();
      } catch {
        /* closed */
      }
      return;
    }
    pending.onChannel(ch);
  }

  /** Control-channel messages relevant to transfers. Returns true if handled. */
  handleControl(peerId: string, msg: PeerMsg): boolean {
    switch (msg.t) {
      case 'file-request':
        void this.onRequest(peerId, msg.transferId, msg.fileId);
        return true;
      case 'file-queued': {
        const p = this.pendingIn.get(msg.transferId);
        if (p && p.peerId === peerId) {
          p.job.view.state = 'requesting';
          p.onQueued();
        }
        return true;
      }
      case 'file-reject': {
        const p = this.pendingIn.get(msg.transferId);
        if (p && p.peerId === peerId) p.onReject(msg.reason);
        return true;
      }
      case 'xfer-cancel': {
        const u = this.uploads.get(msg.transferId);
        if (u && u.peerId === peerId) u.abort('Cancelled by receiver');
        this.uploadQueue = this.uploadQueue.filter((q) => q.id !== msg.transferId || q.peerId !== peerId);
        this.dropQueuedView(msg.transferId, peerId);
        return true;
      }
      default:
        return false;
    }
  }

  cancel(id: string) {
    const d = this.downloads.get(id);
    if (d) {
      d.cancelled = true;
      this.downloadQueue = this.downloadQueue.filter((j) => j !== d);
      d.abortAttempt?.(new SourceFailure('Cancelled'));
      this.finishDownload(d, { ok: false, cancelled: true, error: 'Cancelled' }, 'cancelled');
      return;
    }
    const u = this.uploads.get(id);
    if (u) u.abort('Cancelled by sender');
  }

  /** A peer disappeared: fail anything that depended on it. */
  handlePeerGone(peerId: string) {
    for (const j of this.downloads.values()) if (j.view.peerId === peerId && j.abortAttempt) j.abortAttempt(new SourceFailure('Peer disconnected'));
    for (const u of [...this.uploads.values()]) if (u.peerId === peerId) u.abort('Peer disconnected');
    this.uploadQueue = this.uploadQueue.filter((u) => u.peerId !== peerId);
    for (const id of [...this.queuedViews.keys()]) if (this.queuedViews.get(id)!.peerId === peerId) this.dropQueuedView(id, peerId);
    this.requestLog.delete(peerId);
  }

  // ============================================================================================
  // Uploading (serving)
  // ============================================================================================

  private queuedViews = new Map<string, TransferView>();

  private dropQueuedView(id: string, peerId: string) {
    const v = this.queuedViews.get(id);
    if (v && v.peerId === peerId) {
      this.queuedViews.delete(id);
      v.state = 'cancelled';
      this.emit(v, true);
    }
  }

  private allowRequest(peerId: string): boolean {
    const now = this.now();
    const log = (this.requestLog.get(peerId) ?? []).filter((t) => now - t < 60_000);
    log.push(now);
    this.requestLog.set(peerId, log);
    return log.length <= MAX_REQUESTS_PER_MIN;
  }

  private async onRequest(peerId: string, transferId: string, fileId: string) {
    const reject = (reason: 'not-found' | 'busy' | 'rate-limited' | 'error') => this.host.sendCtl(peerId, { t: 'file-reject', transferId, reason });
    if (!isId(transferId) || !isId(fileId)) return;
    if (!this.allowRequest(peerId)) return reject('rate-limited');
    if (this.uploads.has(transferId) || this.queuedViews.has(transferId)) return;
    const perPeer = [...this.uploads.values()].filter((u) => u.peerId === peerId).length + this.uploadQueue.filter((u) => u.peerId === peerId).length;
    if (perPeer >= MAX_UPLOADS_PER_PEER) return reject('busy');
    const meta = this.host.getMeta(fileId);
    if (!meta) return reject('not-found');
    let source: Blob | null = null;
    try {
      source = await this.host.getSource(fileId);
    } catch {
      return reject('error');
    }
    if (!source || source.size !== meta.size) return reject('not-found');

    const view: TransferView = {
      id: transferId,
      fileId,
      direction: 'up',
      peerId,
      name: meta.name,
      size: meta.size,
      bytes: 0,
      speed: 0,
      eta: null,
      state: 'queued',
      startedAt: this.now(),
      keep: false,
    };
    const job: UploadJob = {
      id: transferId,
      peerId,
      fileId,
      view,
      speed: new SpeedMeter(),
      source,
      ch: null,
      cancelled: false,
      acked: 0,
      ackWaiters: [],
      abort: () => undefined,
      lastEmit: 0,
    };
    if (this.activeUploads >= this.host.settings().maxUploads) {
      this.uploadQueue.push(job);
      this.queuedViews.set(transferId, view);
      this.host.sendCtl(peerId, { t: 'file-queued', transferId, position: this.uploadQueue.length });
      this.emit(view, true);
      return;
    }
    this.startUpload(job);
  }

  private startUpload(job: UploadJob) {
    this.queuedViews.delete(job.id);
    this.activeUploads++;
    this.uploads.set(job.id, job);
    void this.runUpload(job).finally(() => {
      this.activeUploads--;
      this.uploads.delete(job.id);
      const next = this.uploadQueue.shift();
      if (next) this.startUpload(next);
    });
  }

  private async runUpload(job: UploadJob) {
    const { view } = job;
    const meta = this.host.getMeta(job.fileId)!;
    const settings = this.host.settings();
    const chunkSize = Math.min(LIMITS.chunkMax, Math.max(LIMITS.chunkMin, settings.chunkSize));
    const totalChunks = Math.ceil(meta.size / chunkSize);
    let failure: string | null = null;
    job.abort = (reason) => {
      if (job.cancelled) return;
      job.cancelled = true;
      failure = reason;
      for (const w of job.ackWaiters.splice(0)) w();
      try {
        if (job.ch?.readyState === 'open') job.ch.send(JSON.stringify({ t: 'error', reason: 'cancelled' } satisfies XferSenderMsg));
      } catch {
        /* closed */
      }
      try {
        job.ch?.close();
      } catch {
        /* closed */
      }
    };
    try {
      const ch = this.host.openChannel(job.peerId, job.id);
      if (!ch) throw new Error('Peer is not connected');
      job.ch = ch;
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = 256 * 1024;
      ch.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let m: XferReceiverMsg;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.t === 'ack' && Number.isFinite(m.bytes) && m.bytes <= meta.size) {
          job.acked = Math.max(job.acked, m.bytes);
          for (const w of job.ackWaiters.splice(0)) w();
        } else if (m.t === 'cancel') job.abort('Cancelled by receiver');
      };
      ch.onclose = () => {
        if (job.acked < meta.size) job.abort('Connection closed');
        else for (const w of job.ackWaiters.splice(0)) w();
      };
      await waitOpen(ch, 20_000);
      if (job.cancelled) throw new Error(failure ?? 'Cancelled');

      view.state = 'sending';
      view.startedAt = this.now();
      this.emit(view, true);
      ch.send(JSON.stringify({ t: 'start', fileId: job.fileId, size: meta.size, chunkSize, chunks: totalChunks, window: settings.windowBytes } satisfies XferSenderMsg));

      let seq = 0;
      let sent = 0;
      // Read in blocks that are a whole number of chunks, so every chunk except the last has exactly `chunkSize` bytes.
      const readBlock = chunkSize * Math.max(1, Math.floor(READ_BLOCK / chunkSize));
      for (let off = 0; off < meta.size; off += readBlock) {
        const block = new Uint8Array(await job.source.slice(off, Math.min(off + readBlock, meta.size)).arrayBuffer());
        for (let p = 0; p < block.length; p += chunkSize) {
          const part = block.subarray(p, Math.min(p + chunkSize, block.length));
          while (!job.cancelled && sent - job.acked >= settings.windowBytes) await new Promise<void>((r) => job.ackWaiters.push(r));
          if (!job.cancelled) await drain(ch, SEND_HIGH_WATER);
          if (job.cancelled || ch.readyState !== 'open') throw new Error(failure ?? 'Connection closed');
          ch.send(encodeFrame(seq++, part));
          sent += part.length;
          view.bytes = Math.max(job.acked, sent - ch.bufferedAmount);
          this.progress(view, job.speed, view.bytes);
        }
      }
      if (job.cancelled) throw new Error(failure ?? 'Cancelled');
      ch.send(JSON.stringify({ t: 'end', chunks: totalChunks, size: meta.size } satisfies XferSenderMsg));

      // The receiver acknowledges only after verifying and committing; wait for that final ack.
      const deadline = this.now() + 120_000;
      while (!job.cancelled && job.acked < meta.size && ch.readyState === 'open' && this.now() < deadline) {
        await Promise.race([new Promise<void>((r) => job.ackWaiters.push(r)), new Promise<void>((r) => setTimeout(r, 1000))]);
      }
      if (job.acked < meta.size) throw new Error(failure ?? 'Receiver did not confirm the file');
      view.bytes = meta.size;
      view.state = 'done';
    } catch (e) {
      view.state = job.cancelled && /cancel/i.test(failure ?? '') ? 'cancelled' : 'failed';
      view.error = failure ?? (e instanceof Error ? e.message : String(e));
    } finally {
      try {
        job.ch?.close();
      } catch {
        /* closed */
      }
      view.speed = 0;
      view.eta = 0;
      this.emit(view, true);
    }
  }

  // ============================================================================================

  private progress(view: TransferView, meter: SpeedMeter, bytes: number) {
    view.speed = meter.record(bytes, this.now());
    view.eta = etaSeconds(view.size, bytes, view.speed);
    this.emit(view, false);
  }

  private lastEmitAt = new Map<string, number>();
  private emit(view: TransferView, force: boolean) {
    const now = this.now();
    if (!force && now - (this.lastEmitAt.get(view.id) ?? 0) < 200) return;
    this.lastEmitAt.set(view.id, now);
    if (view.state === 'done' || view.state === 'failed' || view.state === 'cancelled') this.lastEmitAt.delete(view.id);
    this.host.onChange({ ...view });
  }

  activeCount() {
    return { downloads: this.activeDownloads, uploads: this.activeUploads, queuedUploads: this.uploadQueue.length, queuedDownloads: this.downloadQueue.length };
  }

  dispose() {
    for (const j of [...this.downloads.values()]) this.cancel(j.id);
    for (const u of [...this.uploads.values()]) u.abort('Shutting down');
  }
}

export function describeStorageError(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'QuotaExceededError') return 'Not enough free browser storage to hold this file';
  if (name === 'NotAllowedError') return 'The browser blocked writing to the chosen file';
  return 'Could not write the file: ' + (e instanceof Error ? e.message : String(e));
}

import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, randomId, sha256, toHex, type FileMeta, type PeerMsg } from '@lanshare/shared';
import { MemorySink } from '../client/src/services/transfers/sinks';
import { TransferManager, type TransferHost, type TransferSettings } from '../client/src/services/transfers/TransferManager';
import type { TransferView } from '../client/src/types';
import { MemoryChannel } from './helpers/memory';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await wait(5);
  }
};

function makeData(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  return out;
}
const metaFor = (data: Uint8Array, uploaderId: string): FileMeta => ({
  fileId: randomId(),
  name: 'data.bin',
  mime: 'application/octet-stream',
  size: data.length,
  sha256: toHex(sha256(data)),
  uploaderId,
});

interface Node {
  id: string;
  tm: TransferManager;
  views: Map<string, TransferView>;
  ctl: Array<{ to: string; msg: PeerMsg }>;
  files: Map<string, Blob | null>;
  metas: Map<string, FileMeta>;
  settings: TransferSettings;
  holders: Map<string, string[]>;
  channels: MemoryChannel[];
  hostOverrides: { openChannel?: (peer: string, id: string) => MemoryChannel | null };
  clock?: () => number;
}

/** Wires several TransferManagers together with in-memory control + transfer channels. */
class Net {
  nodes = new Map<string, Node>();
  /** channel hooks so tests can tamper with the data path */
  onNewChannel: ((from: string, to: string, ch: MemoryChannel) => void) | null = null;
  ctlFilter: ((from: string, to: string, msg: PeerMsg) => boolean) | null = null;

  add(id: string, over: Partial<TransferSettings> = {}): Node {
    const node: Node = {
      id,
      views: new Map(),
      ctl: [],
      files: new Map(),
      metas: new Map(),
      holders: new Map(),
      channels: [],
      hostOverrides: {},
      settings: { maxUploads: 3, maxDownloads: 3, chunkSize: 16 * 1024, windowBytes: 256 * 1024, maxFileSize: 1 << 30, ...over },
      tm: undefined as unknown as TransferManager,
    };
    const host: TransferHost = {
      sendCtl: (to, msg) => {
        node.ctl.push({ to, msg });
        if (!this.nodes.has(to)) return false;
        if (this.ctlFilter && !this.ctlFilter(id, to, msg)) return true;
        setTimeout(() => this.nodes.get(to)?.tm.handleControl(id, msg), 0);
        return true;
      },
      openChannel: (to, tid) => {
        if (node.hostOverrides.openChannel) return node.hostOverrides.openChannel(to, tid);
        const peer = this.nodes.get(to);
        if (!peer) return null;
        const [mine, theirs] = MemoryChannel.pair('xfer:' + tid);
        node.channels.push(mine);
        this.onNewChannel?.(id, to, mine);
        setTimeout(() => {
          peer.tm.handleIncomingChannel(id, theirs, tid);
          mine.open();
        }, 0);
        return mine;
      },
      getMeta: (fid) => node.metas.get(fid),
      getSource: async (fid) => node.files.get(fid) ?? null,
      holders: (fid) => node.holders.get(fid) ?? [],
      settings: () => node.settings,
      onChange: (v) => node.views.set(v.id, v),
      now: () => node.clock?.() ?? Date.now(),
    };
    node.tm = new TransferManager(host);
    this.nodes.set(id, node);
    return node;
  }
  share(owner: Node, data: Uint8Array, others: Node[] = []): FileMeta {
    const meta = metaFor(data, owner.id);
    owner.files.set(meta.fileId, new Blob([data as BlobPart]));
    for (const n of [owner, ...others]) n.metas.set(meta.fileId, meta);
    for (const n of others) n.holders.set(meta.fileId, [owner.id]);
    return meta;
  }
}

const fileId = () => randomId();
void fileId;

describe('file transfer protocol', () => {
  it.each([0, 1, 16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1, 700_000])('transfers a %i-byte file intact with SHA-256 verification', async (size) => {
    const net = new Net();
    const A = net.add('A');
    const B = net.add('B');
    const data = makeData(size);
    const meta = net.share(A, data, [B]);
    const sink = new MemorySink();
    const { done } = B.tm.download({ fileId: meta.fileId, sink, keep: false });
    const res = await done;
    expect(res).toMatchObject({ ok: true, from: 'A' });
    expect(sink.committed).toBe(true);
    expect(toHex(sha256(sink.bytes()))).toBe(meta.sha256);
    expect(sink.bytes().length).toBe(size);
    const v = [...B.views.values()].at(-1)!;
    expect(v.state).toBe('done');
    expect(v.bytes).toBe(size);
    await until(() => [...A.views.values()].some((u) => u.direction === 'up' && u.state === 'done'));
  });

  it.each([10_000, 100_000, 262_128])('transfers correctly when the chunk size (%i) does not divide the read block', async (chunkSize) => {
    const net = new Net();
    const A = net.add('A', { chunkSize });
    const B = net.add('B');
    const meta = net.share(A, makeData(3_300_001, 4), [B]);
    const sink = new MemorySink();
    const res = await B.tm.download({ fileId: meta.fileId, sink, keep: false }).done;
    expect(res.error).toBeUndefined();
    expect(toHex(sha256(sink.bytes()))).toBe(meta.sha256);
  });

  it('reports progress, speed and ETA while transferring', async () => {
    const net = new Net();
    const A = net.add('A', { chunkSize: 4096 });
    const B = net.add('B');
    const meta = net.share(A, makeData(600_000), [B]);
    let t = 1_000_000;
    B.clock = () => (t += 120); // fake time so the 200 ms UI throttle lets intermediate updates through
    const seen: TransferView[] = [];
    const orig = B.views.set.bind(B.views);
    B.views.set = (k, v) => (seen.push(v), orig(k, v));
    const { done } = B.tm.download({ fileId: meta.fileId, sink: new MemorySink(), keep: false });
    await done;
    const mid = seen.filter((v) => v.state === 'receiving' && v.bytes > 0 && v.bytes < v.size);
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.some((v) => v.speed > 0)).toBe(true);
    expect(seen.map((v) => v.bytes)).toEqual([...seen.map((v) => v.bytes)].sort((a, b) => a - b));
  });

  it('applies back-pressure: the sender never runs more than the window ahead of the receiver', async () => {
    const net = new Net();
    const A = net.add('A', { chunkSize: 16 * 1024, windowBytes: 64 * 1024 });
    const B = net.add('B');
    const meta = net.share(A, makeData(2_000_000), [B]);
    let maxBuffered = 0;
    net.onNewChannel = (_f, _t, ch) => {
      const orig = ch.send.bind(ch);
      ch.send = (d) => {
        orig(d);
        maxBuffered = Math.max(maxBuffered, ch.bufferedAmount);
      };
    };
    const { done } = B.tm.download({ fileId: meta.fileId, sink: new MemorySink(), keep: false });
    expect((await done).ok).toBe(true);
    expect(maxBuffered).toBeLessThanOrEqual(64 * 1024 + 16 * 1024 + 8);
  });

  it('serves several downloaders of the same file simultaneously', async () => {
    const net = new Net();
    const A = net.add('A');
    const B = net.add('B');
    const C = net.add('C');
    const data = makeData(500_000, 9);
    const meta = net.share(A, data, [B, C]);
    const sb = new MemorySink();
    const sc = new MemorySink();
    const [rb, rc] = await Promise.all([B.tm.download({ fileId: meta.fileId, sink: sb, keep: false }).done, C.tm.download({ fileId: meta.fileId, sink: sc, keep: false }).done]);
    expect(rb.ok && rc.ok).toBe(true);
    expect(toHex(sha256(sb.bytes()))).toBe(meta.sha256);
    expect(toHex(sha256(sc.bytes()))).toBe(meta.sha256);
  });

  it('queues uploads beyond the concurrency limit and then completes them all', async () => {
    const net = new Net();
    const A = net.add('A', { maxUploads: 1, chunkSize: 4096 });
    const B = net.add('B');
    const metas = [1, 2, 3].map((i) => net.share(A, makeData(120_000, i), [B]));
    let maxActive = 0;
    const origSet = A.views.set.bind(A.views);
    A.views.set = (k, v) => {
      origSet(k, v);
      maxActive = Math.max(maxActive, [...A.views.values()].filter((x) => x.state === 'sending').length);
      return A.views;
    };
    const sinks = metas.map(() => new MemorySink());
    const results = await Promise.all(metas.map((m, i) => B.tm.download({ fileId: m.fileId, sink: sinks[i], keep: false }).done));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxActive).toBe(1);
    expect(A.ctl.some((c) => c.msg.t === 'file-queued')).toBe(true);
    sinks.forEach((s, i) => expect(toHex(sha256(s.bytes()))).toBe(metas[i].sha256));
  });

  it('limits concurrent downloads on the receiving side', async () => {
    const net = new Net();
    const A = net.add('A');
    const B = net.add('B', { maxDownloads: 1 });
    const metas = [1, 2].map((i) => net.share(A, makeData(200_000, i), [B]));
    const jobs = metas.map((m) => B.tm.download({ fileId: m.fileId, sink: new MemorySink(), keep: false }));
    expect(B.tm.activeCount().queuedDownloads).toBe(1);
    expect((await Promise.all(jobs.map((j) => j.done))).every((r) => r.ok)).toBe(true);
  });

  it('detects corrupted data, discards it and reports an integrity failure', async () => {
    const net = new Net();
    const A = net.add('A');
    const B = net.add('B');
    const meta = net.share(A, makeData(100_000), [B]);
    net.onNewChannel = (_f, _t, ch) => {
      let n = 0;
      ch.tamper = (d) => {
        if (typeof d !== 'string' && ++n === 3) {
          const copy = new Uint8Array(d.slice(0));
          copy[100] ^= 0xff; // flip a payload byte; size and sequence stay valid
          return copy.buffer;
        }
        return d;
      };
    };
    const sink = new MemorySink();
    const res = await B.tm.download({ fileId: meta.fileId, sink, keep: false }).done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Integrity|SHA-256|source/i);
    expect(sink.committed).toBe(false);
    expect(sink.aborted).toBe(true);
  });

  it('falls back to another peer when the first source serves corrupt data', async () => {
    const net = new Net();
    const A = net.add('A');
    const C = net.add('C');
    const B = net.add('B');
    const data = makeData(80_000);
    const meta = net.share(A, data, [B, C]);
    C.files.set(meta.fileId, new Blob([data as BlobPart]));
    B.holders.set(meta.fileId, ['A', 'C']);
    net.onNewChannel = (from, _t, ch) => {
      if (from !== 'A') return;
      ch.tamper = (d) => {
        if (typeof d === 'string') return d;
        const copy = new Uint8Array(d.slice(0));
        copy[10] ^= 1;
        return copy.buffer;
      };
    };
    const sink = new MemorySink();
    const res = await B.tm.download({ fileId: meta.fileId, sink, keep: false }).done;
    expect(res).toMatchObject({ ok: true, from: 'C' });
    expect(toHex(sha256(sink.bytes()))).toBe(meta.sha256);
  });

  it('fails over to another holder when the source disconnects mid-transfer', async () => {
    const net = new Net();
    const A = net.add('A', { chunkSize: 4096, windowBytes: 32 * 1024 });
    const C = net.add('C', { chunkSize: 4096 });
    const B = net.add('B');
    const data = makeData(400_000);
    const meta = net.share(A, data, [B, C]);
    C.files.set(meta.fileId, new Blob([data as BlobPart]));
    B.holders.set(meta.fileId, ['A', 'C']);
    const sink = new MemorySink();
    const job = B.tm.download({ fileId: meta.fileId, sink, keep: false });
    await until(() => [...B.views.values()].some((v) => v.state === 'receiving' && v.bytes > 20_000));
    B.holders.set(meta.fileId, ['C']);
    A.channels.forEach((c) => c.close()); // the uploader's connection dies
    const res = await job.done;
    expect(res).toMatchObject({ ok: true, from: 'C' });
    expect(toHex(sha256(sink.bytes()))).toBe(meta.sha256);
  });

  it('fails with a clear error (and no partial output) when the only source disappears', async () => {
    const net = new Net();
    const A = net.add('A', { chunkSize: 4096, windowBytes: 32 * 1024 });
    const B = net.add('B');
    const meta = net.share(A, makeData(400_000), [B]);
    const sink = new MemorySink();
    const job = B.tm.download({ fileId: meta.fileId, sink, keep: false });
    await until(() => [...B.views.values()].some((v) => v.state === 'receiving' && v.bytes > 20_000));
    B.holders.set(meta.fileId, []);
    B.tm.handlePeerGone('A');
    const res = await job.done;
    expect(res.ok).toBe(false);
    expect(sink.committed).toBe(false);
    expect(sink.aborted).toBe(true);
    expect(B.views.get([...B.views.keys()][0])!.state).toBe('failed');
  });

  it('fails immediately when no peer has the file', async () => {
    const net = new Net();
    const B = net.add('B');
    const A = net.add('A');
    const meta = net.share(A, makeData(10), [B]);
    B.holders.set(meta.fileId, []);
    const res = await B.tm.download({ fileId: meta.fileId, sink: new MemorySink(), keep: false }).done;
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/No online peer/) });
  });

  it('supports cancelling a download in flight and tells the sender to stop', async () => {
    const net = new Net();
    const A = net.add('A', { chunkSize: 4096, windowBytes: 32 * 1024 });
    const B = net.add('B');
    const meta = net.share(A, makeData(1_500_000), [B]);
    const sink = new MemorySink();
    const { id, done } = B.tm.download({ fileId: meta.fileId, sink, keep: false });
    await until(() => [...B.views.values()].some((v) => v.state === 'receiving' && v.bytes > 10_000));
    B.tm.cancel(id);
    const res = await done;
    expect(res.cancelled).toBe(true);
    expect(sink.aborted).toBe(true);
    expect(B.views.get(id)!.state).toBe('cancelled');
    await until(() => [...A.views.values()].every((v) => ['failed', 'cancelled'].includes(v.state)));
    expect(A.tm.activeCount().uploads).toBe(0);
  });

  it('can cancel a queued download before it starts', async () => {
    const net = new Net();
    const A = net.add('A');
    const B = net.add('B', { maxDownloads: 1 });
    const m1 = net.share(A, makeData(300_000, 1), [B]);
    const m2 = net.share(A, makeData(300_000, 2), [B]);
    const j1 = B.tm.download({ fileId: m1.fileId, sink: new MemorySink(), keep: false });
    const j2 = B.tm.download({ fileId: m2.fileId, sink: new MemorySink(), keep: false });
    B.tm.cancel(j2.id);
    expect((await j2.done).cancelled).toBe(true);
    expect((await j1.done).ok).toBe(true);
  });

  it('refuses to serve unknown files, size-mismatched sources and flooding peers', async () => {
    const net = new Net();
    const A = net.add('A');
    const meta = net.share(A, makeData(1000), []);
    const rejects = () => A.ctl.filter((c) => c.msg.t === 'file-reject').map((c) => (c.msg as { reason: string }).reason);
    net.add('B');
    A.tm.handleControl('B', { t: 'file-request', transferId: randomId(), fileId: randomId() }); // unknown file
    await until(() => rejects().includes('not-found'));
    A.files.set(meta.fileId, new Blob([new Uint8Array(999)])); // local file changed size
    A.tm.handleControl('B', { t: 'file-request', transferId: randomId(), fileId: meta.fileId });
    await until(() => rejects().length === 2);
    for (let i = 0; i < 60; i++) A.tm.handleControl('B', { t: 'file-request', transferId: randomId(), fileId: randomId() });
    await until(() => rejects().includes('rate-limited'));
    A.tm.handleControl('B', { t: 'file-request', transferId: 'bad id!', fileId: '<x>' }); // malformed ids are ignored silently
  });

  it('rejects files above the receiver-side size limit', async () => {
    const net = new Net();
    const A = net.add('A');
    const B = net.add('B', { maxFileSize: 100 });
    const meta = net.share(A, makeData(5000), [B]);
    const res = await B.tm.download({ fileId: meta.fileId, sink: new MemorySink(), keep: false }).done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/size limit/);
  });
});

describe('malicious senders', () => {
  /** A hand-driven sender that speaks the wire protocol with deliberate violations. */
  async function attack(script: (ch: MemoryChannel, meta: FileMeta) => void | Promise<void>, size = 40_000) {
    const net = new Net();
    const B = net.add('B');
    const evil = net.add('E');
    const data = makeData(size);
    const meta = net.share(evil, data, [B]);
    // the "evil" node answers requests with a scripted channel instead of the real uploader
    evil.tm.handleControl = (_peer: string, msg: PeerMsg) => {
      if (msg.t !== 'file-request') return true;
      const [mine, theirs] = MemoryChannel.pair('xfer:' + msg.transferId);
      setTimeout(async () => {
        B.tm.handleIncomingChannel('E', theirs, msg.transferId);
        mine.open();
        await script(mine, meta);
      }, 0);
      return true;
    };
    const sink = new MemorySink();
    const res = await B.tm.download({ fileId: meta.fileId, sink, keep: false }).done;
    return { res, sink, meta, data };
  }
  const start = (m: FileMeta, over: Record<string, unknown> = {}) => JSON.stringify({ t: 'start', fileId: m.fileId, size: m.size, chunkSize: 4096, chunks: Math.ceil(m.size / 4096), window: 65536, ...over });

  it('rejects a start message whose size does not match the signed metadata', async () => {
    const { res, sink } = await attack((ch, m) => ch.send(start(m, { size: m.size + 1 })));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not match/);
    expect(sink.committed).toBe(false);
  });

  it('rejects absurd chunk sizes', async () => {
    const { res } = await attack((ch, m) => ch.send(start(m, { chunkSize: 1 << 30, chunks: 1 })));
    expect(res.ok).toBe(false);
  });

  it('rejects chunks sent out of sequence', async () => {
    const { res } = await attack((ch, m) => {
      ch.send(start(m));
      ch.send(encodeFrame(1, new Uint8Array(4096)));
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sequence/);
  });

  it('rejects oversized chunks and data beyond the declared total', async () => {
    const r1 = await attack((ch, m) => {
      ch.send(start(m));
      ch.send(encodeFrame(0, new Uint8Array(5000)));
    });
    expect(r1.res.error).toMatch(/wrong size/);
    const r2 = await attack((ch, m) => {
      ch.send(start(m, { size: m.size, chunks: Math.ceil(m.size / 4096) }));
      for (let i = 0; i < 12; i++) ch.send(encodeFrame(i, new Uint8Array(4096)));
    }, 40_000);
    expect(r2.res.ok).toBe(false);
  });

  it('rejects data before start, truncated transfers and garbage frames', async () => {
    expect((await attack((ch) => ch.send(encodeFrame(0, new Uint8Array(10))))).res.ok).toBe(false);
    const trunc = await attack((ch, m) => {
      ch.send(start(m));
      ch.send(encodeFrame(0, new Uint8Array(4096)));
      ch.send(JSON.stringify({ t: 'end', chunks: 10, size: m.size }));
    });
    expect(trunc.res.ok).toBe(false);
    expect((await attack((ch, m) => { ch.send(start(m)); ch.send(new Uint8Array([1, 2]).buffer); })).res.ok).toBe(false);
    expect((await attack((ch) => ch.send('{not json'))).res.ok).toBe(false);
  });

  it('rejects a transfer whose bytes are well-formed but do not match the checksum', async () => {
    const { res, sink } = await attack((ch, m) => {
      ch.send(start(m));
      const total = Math.ceil(m.size / 4096);
      for (let i = 0; i < total; i++) ch.send(encodeFrame(i, new Uint8Array(Math.min(4096, m.size - i * 4096)))); // all zeros
      ch.send(JSON.stringify({ t: 'end', chunks: total, size: m.size }));
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Integrity/);
    expect(sink.committed).toBe(false);
  });

  it('ignores channels that were never requested', async () => {
    const net = new Net();
    const B = net.add('B');
    const [, theirs] = MemoryChannel.pair('xfer:' + randomId());
    B.tm.handleIncomingChannel('X', theirs, randomId());
    expect(theirs.readyState).toBe('closed');
  });

  it('frame codec round-trips', () => {
    const f = encodeFrame(0xdeadbeef, new Uint8Array([1, 2, 3]));
    expect(decodeFrame(f)).toEqual({ seq: 0xdeadbeef, payload: new Uint8Array([1, 2, 3]) });
    expect(decodeFrame(new Uint8Array([1]))).toBeNull();
  });
});

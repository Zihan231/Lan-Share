import { beforeEach, describe, expect, it } from 'vitest';
import {
  compareRecords,
  generateKeyPair,
  peerIdFromPublicKey,
  randomId,
  signRecord,
  toB64u,
  validateRecord,
  type RoomRecord,
  type UnsignedRecord,
} from '@lanshare/shared';
import { MemoryPersistence, RecordStore, batchRecords } from '../client/src/services/sync/RecordStore';
import { FRAGMENT_SIZE, Reassembler, encodeMessage } from '../client/src/services/webrtc/framing';

function who() {
  const kp = generateKeyPair();
  const pk = toB64u(kp.publicKey);
  return { kp, pk, id: peerIdFromPublicKey(pk) };
}
type Who = ReturnType<typeof who>;

let clock = 1_700_000_000_000;
const mk = (w: Who, part: Partial<UnsignedRecord> = {}): RoomRecord =>
  signRecord({ id: randomId(), roomId: 'r', kind: 'text', authorId: w.id, authorKey: w.pk, authorName: 'N', ts: clock++, text: 'hi ' + clock, ...part }, w.kp.secretKey);
const del = (w: Who, target: string): RoomRecord => mk(w, { kind: 'delete', target, text: undefined });

/** The sync handshake used by the engine: A advertises its ids, B sends what A lacks (and vice versa). */
async function syncPair(a: RecordStore, b: RecordStore) {
  const aIds = new Set(a.allIds());
  const bIds = new Set(b.allIds());
  for (const r of b.missingFor(aIds)) await a.add(validateRecord(r)!);
  for (const r of a.missingFor(bIds)) await b.add(validateRecord(r)!);
}

describe('RecordStore', () => {
  const alice = who();
  const bob = who();
  let store: RecordStore;
  let db: MemoryPersistence;
  beforeEach(async () => {
    db = new MemoryPersistence();
    store = new RecordStore('r', db);
    await store.load();
  });

  it('deduplicates by stable id (reconnect / double relay)', async () => {
    const r = mk(alice);
    expect(await store.add(r)).toBe('added');
    expect(await store.add(r)).toBe('duplicate');
    expect(await store.add({ ...r })).toBe('duplicate');
    expect(store.visible).toHaveLength(1);
    expect(db.data.size).toBe(1);
  });

  it('orders records deterministically by (timestamp, id) regardless of arrival order', async () => {
    const recs = [mk(alice), mk(bob), mk(alice, { ts: 5 }), mk(bob, { ts: 5 }), mk(alice)];
    const s1 = new RecordStore('r', new MemoryPersistence());
    const s2 = new RecordStore('r', new MemoryPersistence());
    for (const r of recs) await s1.add(r);
    for (const r of [...recs].reverse()) await s2.add(r);
    expect(s1.visible.map((r) => r.id)).toEqual(s2.visible.map((r) => r.id));
    expect([...s1.visible].sort(compareRecords).map((r) => r.id)).toEqual(s1.visible.map((r) => r.id));
  });

  it('rejects records from other rooms', async () => {
    expect(await store.add({ ...mk(alice), roomId: 'other' })).toBe('wrong-room');
  });

  it('persists and restores after reload', async () => {
    const r1 = mk(alice);
    const r2 = mk(bob);
    await store.add(r1);
    await store.add(r2);
    const again = new RecordStore('r', db);
    await again.load();
    expect(again.visible.map((r) => r.id)).toEqual([r1.id, r2.id]);
  });

  it('converges after a new peer joins and syncs (history merge)', async () => {
    const old = new RecordStore('r', new MemoryPersistence());
    const fresh = new RecordStore('r', new MemoryPersistence());
    for (let i = 0; i < 25; i++) await old.add(mk(i % 2 ? alice : bob));
    await syncPair(old, fresh);
    expect(fresh.visible.map((r) => r.id)).toEqual(old.visible.map((r) => r.id));
    // a second sync transfers nothing
    expect(fresh.missingFor(new Set(old.allIds()))).toHaveLength(0);
    expect(old.missingFor(new Set(fresh.allIds()))).toHaveLength(0);
  });

  it('merges diverged histories from partitioned peers', async () => {
    const a = new RecordStore('r', new MemoryPersistence());
    const b = new RecordStore('r', new MemoryPersistence());
    const common = mk(alice);
    await a.add(common);
    await b.add(common);
    await a.add(mk(alice));
    await a.add(mk(alice));
    await b.add(mk(bob));
    await syncPair(a, b);
    expect(a.visible.map((r) => r.id)).toEqual(b.visible.map((r) => r.id));
    expect(a.visible).toHaveLength(4);
  });

  describe('deletion tombstones', () => {
    it('author can delete; content is dropped but the tombstone persists', async () => {
      const r = mk(alice);
      await store.add(r);
      await store.add(del(alice, r.id));
      expect(store.visible).toHaveLength(0);
      expect(db.data.has(r.id)).toBe(false);
      expect([...db.data.values()].some((x) => x.kind === 'delete')).toBe(true);
    });

    it('a stale peer cannot resurrect a deleted record', async () => {
      const r = mk(alice);
      await store.add(r);
      await store.add(del(alice, r.id));
      expect(await store.add(r)).toBe('duplicate');
      expect(store.visible).toHaveLength(0);
      // and the record id is advertised so peers do not even send it
      expect(store.allIds()).toContain(r.id);
    });

    it('tombstone arriving before its target still hides the target', async () => {
      const r = mk(alice);
      await store.add(del(alice, r.id));
      expect(await store.add(r)).toBe('tombstoned');
      expect(store.visible).toHaveLength(0);
    });

    it('ignores deletes by non-authors who are not admins, honours admins', async () => {
      const r = mk(alice);
      await store.add(r);
      await store.add(del(bob, r.id));
      expect(store.visible).toHaveLength(1);
      store.setAdmins([bob.id]);
      await new Promise((res) => setTimeout(res, 5));
      expect(store.visible).toHaveLength(0);
    });

    it('propagates deletion through sync to a peer holding the original', async () => {
      const a = new RecordStore('r', new MemoryPersistence());
      const b = new RecordStore('r', new MemoryPersistence());
      const r = mk(alice);
      await a.add(r);
      await b.add(r);
      await a.add(del(alice, r.id));
      await syncPair(a, b);
      expect(b.visible).toHaveLength(0);
    });
  });

  it('clearHistory is local and old records re-sent by peers are ignored', async () => {
    const a = mk(alice);
    await store.add(a);
    await store.clearHistory(a.ts + 1);
    expect(store.visible).toHaveLength(0);
    expect(await store.add(a)).toBe('cleared');
    const newer = mk(alice, { ts: a.ts + 100 });
    expect(await store.add(newer)).toBe('added');
  });

  it('indexes files from file records', async () => {
    const f = { fileId: randomId(), name: 'a.zip', mime: 'application/zip', size: 5, sha256: 'b'.repeat(64), uploaderId: alice.id };
    await store.add(mk(alice, { kind: 'file', files: [f], text: undefined }));
    expect(store.fileEntries().map((e) => e.meta.fileId)).toEqual([f.fileId]);
    expect(store.fileMeta(f.fileId)?.name).toBe('a.zip');
    expect(store.fileMeta('nope')).toBeUndefined();
  });

  it('batches by count and size', () => {
    const recs = Array.from({ length: 250 }, () => mk(alice));
    const batches = batchRecords(recs, 100);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batchRecords(recs, 1000, 2000).every((b) => b.length >= 1)).toBe(true);
  });
});

describe('message fragmentation', () => {
  it('sends small messages whole and large ones in fragments that reassemble exactly', () => {
    const small = encodeMessage({ t: 'ping', n: 1 });
    expect(small).toHaveLength(1);
    const big = { t: 'sync-records', recs: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'x'.repeat(200), uni: 'héllo 🌍' })) };
    const parts = encodeMessage(big);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= FRAGMENT_SIZE + 40)).toBe(true);
    const r = new Reassembler();
    const out = parts.map((p) => r.push(p)).filter((x) => x !== undefined);
    expect(out).toEqual([big]);
  });

  it('reassembles interleaved messages', () => {
    const a = { v: 'a'.repeat(30_000) };
    const b = { v: 'b'.repeat(30_000) };
    const pa = encodeMessage(a);
    const pb = encodeMessage(b);
    const r = new Reassembler();
    const got: unknown[] = [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) for (const p of [pa[i], pb[i]]) if (p) { const o = r.push(p); if (o) got.push(o); }
    expect(got).toEqual([a, b]);
  });

  it('throws on malformed or inconsistent fragments', () => {
    const r = new Reassembler();
    expect(() => r.push('Zjunk')).toThrow();
    expect(() => r.push('Fnot-a-header')).toThrow();
    expect(() => r.push('Fa:9:3:data')).toThrow();
    r.push('Fb:0:3:aa');
    expect(() => r.push('Fb:0:3:aa')).toThrow(); // duplicate index
    expect(() => r.push('Fb:1:4:aa')).toThrow(); // inconsistent total
    expect(() => new Reassembler().push('J{bad json')).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  fingerprintOf,
  fromB64u,
  generateKeyPair,
  isDeleteAuthorised,
  peerIdFromPublicKey,
  randomId,
  sanitizeFileName,
  sanitizeName,
  sha256,
  sign,
  signRecord,
  toB64u,
  toHex,
  validateFileMeta,
  validateRecord,
  validateSignal,
  verify,
  type FileMeta,
  type RoomRecord,
  type UnsignedRecord,
} from '@lanshare/shared';

function identity() {
  const kp = generateKeyPair();
  const pk = toB64u(kp.publicKey);
  return { kp, pk, id: peerIdFromPublicKey(pk) };
}

const meta = (uploaderId: string, over: Partial<FileMeta> = {}): FileMeta => ({
  fileId: randomId(),
  name: 'report.pdf',
  mime: 'application/pdf',
  size: 1234,
  sha256: 'a'.repeat(64),
  uploaderId,
  ...over,
});

function textRecord(who: ReturnType<typeof identity>, over: Partial<UnsignedRecord> = {}): RoomRecord {
  return signRecord(
    { id: randomId(), roomId: 'lanshare', kind: 'text', authorId: who.id, authorKey: who.pk, authorName: 'Alice', ts: Date.now(), text: 'hello', ...over },
    who.kp.secretKey,
  );
}

describe('identifiers and crypto', () => {
  it('generates unique 128-bit ids', () => {
    const ids = new Set(Array.from({ length: 2000 }, randomId));
    expect(ids.size).toBe(2000);
    expect(fromB64u([...ids][0]).length).toBe(16);
  });

  it('derives the peer id from the public key and signs/verifies', () => {
    const a = identity();
    const b = identity();
    expect(a.id).not.toBe(b.id);
    expect(peerIdFromPublicKey(a.pk)).toBe(a.id);
    const sig = sign('msg', a.kp.secretKey);
    expect(verify(sig, 'msg', a.pk)).toBe(true);
    expect(verify(sig, 'msg!', a.pk)).toBe(false);
    expect(verify(sig, 'msg', b.pk)).toBe(false);
    expect(verify('not-a-sig', 'msg', a.pk)).toBe(false);
    expect(fingerprintOf(a.pk)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(canonicalJson({ a: [2, { d: 1 }], b: 1 }));
  });

  it('incremental SHA-256 matches the one-shot digest and known vector', () => {
    const data = new Uint8Array(100_000).map((_, i) => (i * 7) & 255);
    const h = sha256.create();
    for (let i = 0; i < data.length; i += 4099) h.update(data.subarray(i, i + 4099));
    expect(toHex(h.digest())).toBe(toHex(sha256(data)));
    expect(toHex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('sanitising', () => {
  it('strips control and bidi characters from names', () => {
    expect(sanitizeName('  Al‮ice\u0000\n  X ')).toBe('Alice X');
    expect(sanitizeName('')).toBe('Guest');
    expect(sanitizeName(42 as unknown)).toBe('Guest');
    expect(sanitizeName('x'.repeat(100)).length).toBe(32);
  });
  it('neutralises path tricks in file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).not.toMatch(/[\\/]/);
    expect(sanitizeFileName('..hidden')).toBe('_hidden');
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('')).toBe('file');
  });
});

describe('file metadata validation', () => {
  const up = randomId();
  it('accepts well-formed metadata', () => {
    expect(validateFileMeta(meta(up))).not.toBeNull();
    expect(validateFileMeta(meta(up, { size: 0 }))).not.toBeNull();
    expect(validateFileMeta(meta(up, { thumb: 'data:image/jpeg;base64,/9j/4AAQ' }))).not.toBeNull();
  });
  it.each([
    ['negative size', { size: -1 }],
    ['fractional size', { size: 1.5 }],
    ['unsafe integer', { size: Number.MAX_SAFE_INTEGER + 2 }],
    ['over limit', { size: 5 * 1024 ** 4 }],
    ['bad checksum', { sha256: 'xyz' }],
    ['uppercase checksum', { sha256: 'A'.repeat(64) }],
    ['empty name', { name: '' }],
    ['path in name', { name: '../x' }],
    ['huge name', { name: 'a'.repeat(300) }],
    ['bad mime', { mime: 'text/html; <script>' }],
    ['non-jpeg thumb', { thumb: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    ['script thumb', { thumb: 'javascript:alert(1)' }],
    ['bad fileId', { fileId: 'short' }],
  ])('rejects %s', (_n, over) => {
    expect(validateFileMeta(meta(up, over as Partial<FileMeta>))).toBeNull();
  });
  it('honours a configured max size', () => {
    expect(validateFileMeta(meta(up, { size: 2000 }), 1000)).toBeNull();
  });
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 5, 'x', [], () => 1]) expect(validateFileMeta(v)).toBeNull();
  });
});

describe('record validation and signatures', () => {
  const alice = identity();
  const mallory = identity();

  it('accepts a signed text record and drops unknown fields', () => {
    const rec = textRecord(alice);
    const out = validateRecord({ ...rec, evil: '<img onerror=x>' });
    expect(out).toEqual(rec);
    expect(out).not.toHaveProperty('evil');
  });

  it('rejects tampered content', () => {
    const rec = textRecord(alice);
    expect(validateRecord({ ...rec, text: 'tampered' })).toBeNull();
    expect(validateRecord({ ...rec, ts: rec.ts + 1 })).toBeNull();
    expect(validateRecord({ ...rec, authorName: 'Bob' })).toBeNull();
  });

  it('rejects impersonation: someone else signing with a claimed author id', () => {
    const forged = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'text', authorId: alice.id, authorKey: alice.pk, authorName: 'Alice', ts: Date.now(), text: 'send me money' }, mallory.kp.secretKey);
    expect(validateRecord(forged)).toBeNull();
    // key swapped to mallory's but id left as alice's
    const swapped = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'text', authorId: alice.id, authorKey: mallory.pk, authorName: 'Alice', ts: Date.now(), text: 'x' }, mallory.kp.secretKey);
    expect(validateRecord(swapped)).toBeNull();
  });

  it('keeps HTML as inert text (rendering escapes it) and rejects empty/oversized text', () => {
    const rec = textRecord(alice, { text: '<script>alert(1)</script><img src=x onerror=alert(2)>' });
    expect(validateRecord(rec)?.text).toContain('<script>');
    expect(validateRecord(textRecord(alice, { text: '' }))).toBeNull();
    expect(validateRecord(textRecord(alice, { text: 'x'.repeat(9000) }))).toBeNull();
  });

  it('validates file records: uploader must be the author, ids unique, metadata valid', () => {
    const ok = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'file', authorId: alice.id, authorKey: alice.pk, authorName: 'Alice', ts: Date.now(), files: [meta(alice.id)] }, alice.kp.secretKey);
    expect(validateRecord(ok)).not.toBeNull();
    const spoofed = signRecord({ ...ok, files: [meta(mallory.id)], sig: undefined } as unknown as UnsignedRecord, alice.kp.secretKey);
    expect(validateRecord(spoofed)).toBeNull();
    const m = meta(alice.id);
    const dup = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'file', authorId: alice.id, authorKey: alice.pk, authorName: 'Alice', ts: Date.now(), files: [m, m] }, alice.kp.secretKey);
    expect(validateRecord(dup)).toBeNull();
    const badMeta = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'file', authorId: alice.id, authorKey: alice.pk, authorName: 'Alice', ts: Date.now(), files: [meta(alice.id, { size: -5 })] }, alice.kp.secretKey);
    expect(validateRecord(badMeta)).toBeNull();
    const none = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'file', authorId: alice.id, authorKey: alice.pk, authorName: 'Alice', ts: Date.now(), files: [] }, alice.kp.secretKey);
    expect(validateRecord(none)).toBeNull();
  });

  it('rejects structurally wrong records', () => {
    for (const v of [null, 'x', [], {}, { ...textRecord(alice), kind: 'weird' }, { ...textRecord(alice), roomId: '../x' }, { ...textRecord(alice), ts: Date.now() + 10 * 24 * 3600_000 }]) {
      expect(validateRecord(v)).toBeNull();
    }
  });

  it('authorises deletes only for the author or an admin', () => {
    const target = textRecord(alice);
    const byAuthor = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'delete', authorId: alice.id, authorKey: alice.pk, authorName: 'A', ts: Date.now(), target: target.id }, alice.kp.secretKey);
    const byMallory = signRecord({ id: randomId(), roomId: 'lanshare', kind: 'delete', authorId: mallory.id, authorKey: mallory.pk, authorName: 'M', ts: Date.now(), target: target.id }, mallory.kp.secretKey);
    expect(isDeleteAuthorised(byAuthor, alice.id, new Set())).toBe(true);
    expect(isDeleteAuthorised(byMallory, alice.id, new Set())).toBe(false);
    expect(isDeleteAuthorised(byMallory, alice.id, new Set([mallory.id]))).toBe(true);
    expect(isDeleteAuthorised(byMallory, undefined, new Set())).toBe(false);
    expect(validateRecord(byAuthor)).not.toBeNull();
  });
});

describe('signal validation', () => {
  it('accepts SDP and ICE payloads and rejects junk', () => {
    expect(validateSignal({ kind: 'offer', sdp: 'v=0' })).toEqual({ kind: 'offer', sdp: 'v=0' });
    expect(validateSignal({ kind: 'candidate', candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 })).not.toBeNull();
    expect(validateSignal({ kind: 'offer', sdp: '' })).toBeNull();
    expect(validateSignal({ kind: 'offer', sdp: 'x'.repeat(30_000) })).toBeNull();
    expect(validateSignal({ kind: 'hack' })).toBeNull();
    expect(validateSignal('x')).toBeNull();
    expect(validateSignal({ kind: 'candidate', candidate: 'x', sdpMid: {}, sdpMLineIndex: 0 })).toBeNull();
  });
});

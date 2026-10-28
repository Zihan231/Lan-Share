import { LIMITS } from './limits.js';
import { canonicalJson } from './encoding.js';
import { peerIdFromPublicKey, sign, verify } from './crypto.js';
import type { FileMeta, RoomRecord, SignalPayload, UnsignedRecord } from './types.js';

const B64U = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length <= max && v.length >= min;

export function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 16 && v.length <= 44 && B64U.test(v);
}

/** Strips control characters and bidi overrides, trims, and clamps. Safe for display in React text nodes. */
export function sanitizeName(name: unknown, fallback = 'Guest'): string {
  if (typeof name !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, LIMITS.nameMax) || fallback;
}

export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩\\/:*?"<>|]/g, '_').replace(/^\.+/, '_').trim();
  return (cleaned || 'file').slice(0, LIMITS.fileNameMax);
}

export function validateRoomId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(v);
}

export function validateFileMeta(v: unknown, maxSize: number = LIMITS.fileSizeHardMax): FileMeta | null {
  if (!isObj(v)) return null;
  const { fileId, name, mime, size, sha256, uploaderId, thumb } = v;
  if (!isId(fileId) || !isId(uploaderId)) return null;
  if (!isStr(name, LIMITS.fileNameMax, 1) || name !== sanitizeFileName(name)) return null;
  if (!isStr(mime, LIMITS.mimeMax) || !/^[\w.+-]*\/?[\w.+-]*$/.test(mime)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > Math.min(maxSize, LIMITS.fileSizeHardMax)) return null;
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
  if (thumb !== undefined) {
    if (!isStr(thumb, LIMITS.thumbMax) || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(thumb)) return null;
  }
  return { fileId, name, mime, size, sha256, uploaderId, ...(thumb ? { thumb } : {}) };
}

/** Message the author signs: the canonical JSON of the record without its signature. */
export function recordSigningBytes(rec: UnsignedRecord): string {
  return canonicalJson(rec);
}

export function signRecord(rec: UnsignedRecord, secretKey: Uint8Array): RoomRecord {
  return { ...rec, sig: sign(recordSigningBytes(rec), secretKey) };
}

/**
 * Structural validation + signature verification. Returns a clean copy (unknown fields dropped)
 * or null. Does NOT decide whether a delete is authorised; see {@link isDeleteAuthorised}.
 */
export function validateRecord(v: unknown, opts: { maxFileSize?: number } = {}): RoomRecord | null {
  if (!isObj(v)) return null;
  const { id, roomId, kind, authorId, authorKey, authorName, ts, text, files, target, sig } = v;
  if (!isId(id) || !validateRoomId(roomId) || !isId(authorId)) return null;
  if (kind !== 'text' && kind !== 'file' && kind !== 'delete') return null;
  if (!isStr(authorKey, 64, 40) || !B64U.test(authorKey) || !isStr(sig, 100, 40) || !B64U.test(sig)) return null;
  if (typeof authorName !== 'string' || authorName !== sanitizeName(authorName)) return null;
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0 || ts > Date.now() + 24 * 3600_000) return null;
  try {
    if (peerIdFromPublicKey(authorKey) !== authorId) return null;
  } catch {
    return null;
  }
  const clean: UnsignedRecord = { id, roomId, kind, authorId, authorKey, authorName, ts };
  if (kind === 'text') {
    if (!isStr(text, LIMITS.textMax, 1) || files !== undefined || target !== undefined) return null;
    clean.text = text;
  } else if (kind === 'file') {
    if (!Array.isArray(files) || files.length < 1 || files.length > LIMITS.filesPerPost || target !== undefined) return null;
    const out: FileMeta[] = [];
    for (const f of files) {
      const m = validateFileMeta(f, opts.maxFileSize);
      // The uploader of every file in a post must be the post's author (prevents attributing files to others).
      if (!m || m.uploaderId !== authorId) return null;
      out.push(m);
    }
    if (new Set(out.map((f) => f.fileId)).size !== out.length) return null;
    clean.files = out;
    if (text !== undefined) {
      if (!isStr(text, LIMITS.textMax)) return null;
      if (text.length) clean.text = text;
    }
  } else {
    if (!isId(target) || text !== undefined || files !== undefined) return null;
    clean.target = target;
  }
  if (JSON.stringify(clean).length > LIMITS.recordMaxBytes) return null;
  if (!verify(sig, recordSigningBytes(clean), authorKey)) return null;
  return { ...clean, sig };
}

/** A delete tombstone is valid when written by the target's author or by a known room admin. */
export function isDeleteAuthorised(tomb: RoomRecord, targetAuthorId: string | undefined, adminIds: ReadonlySet<string>): boolean {
  if (tomb.kind !== 'delete') return false;
  if (adminIds.has(tomb.authorId)) return true;
  return targetAuthorId !== undefined && tomb.authorId === targetAuthorId;
}

export function compareRecords(a: { ts: number; id: string }, b: { ts: number; id: string }): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function validateSignal(v: unknown): SignalPayload | null {
  if (!isObj(v)) return null;
  if (v.kind === 'offer' || v.kind === 'answer') {
    return isStr(v.sdp, LIMITS.sdpMax, 1) ? { kind: v.kind, sdp: v.sdp } : null;
  }
  if (v.kind === 'candidate') {
    if (!isStr(v.candidate, 1000)) return null;
    const mid = v.sdpMid === null || v.sdpMid === undefined ? null : isStr(v.sdpMid, 64) ? v.sdpMid : undefined;
    if (mid === undefined) return null;
    const idx =
      v.sdpMLineIndex === null || v.sdpMLineIndex === undefined ? null : Number.isInteger(v.sdpMLineIndex) ? (v.sdpMLineIndex as number) : undefined;
    if (idx === undefined) return null;
    return { kind: 'candidate', candidate: v.candidate, sdpMid: mid, sdpMLineIndex: idx };
  }
  return null;
}

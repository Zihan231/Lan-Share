/** Messages exchanged over the per-peer control DataChannel ("ctl"). */
import type { RoomRecord } from './types.js';

export type PeerMsg =
  | { t: 'hello'; peerId: string; key: string; name: string; nonce: string; v: number }
  | { t: 'auth'; sig: string }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number }
  | { t: 'profile'; name: string }
  | { t: 'record'; rec: RoomRecord }
  | { t: 'ack'; ids: string[] }
  | { t: 'sync-have'; ids: string[] }
  | { t: 'sync-records'; recs: RoomRecord[] }
  | { t: 'files-have'; full: boolean; add: string[]; remove: string[] }
  | { t: 'file-request'; transferId: string; fileId: string }
  | { t: 'file-queued'; transferId: string; position: number }
  | { t: 'file-reject'; transferId: string; reason: FileRejectReason }
  | { t: 'xfer-cancel'; transferId: string };

export type FileRejectReason = 'not-found' | 'busy' | 'rate-limited' | 'error';

/** Messages on a per-transfer channel (label `xfer:<transferId>`), sender → receiver. */
export type XferSenderMsg =
  | { t: 'start'; fileId: string; size: number; chunkSize: number; chunks: number; /** sender's flow-control window in bytes */ window: number }
  | { t: 'end'; chunks: number; size: number }
  | { t: 'error'; reason: string };

/** receiver → sender */
export type XferReceiverMsg = { t: 'ack'; bytes: number } | { t: 'cancel' };

/**
 * What a peer signs to prove its identity on a freshly opened channel. It is bound to both DTLS
 * fingerprints so a man-in-the-middle signaling server cannot splice two sessions together.
 */
export function authMessage(verifierNonce: string, signerFp: string, verifierFp: string): string {
  return `lanshare-auth|v1|${verifierNonce}|${signerFp}|${verifierFp}`;
}

/** Binary chunk frame: 4-byte big-endian sequence number followed by payload. */
export const FRAME_HEADER = 4;
export function encodeFrame(seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER + payload.length);
  new DataView(out.buffer).setUint32(0, seq, false);
  out.set(payload, FRAME_HEADER);
  return out;
}
export function decodeFrame(buf: ArrayBuffer | Uint8Array): { seq: number; payload: Uint8Array } | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < FRAME_HEADER) return null;
  const seq = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, false);
  return { seq, payload: u8.subarray(FRAME_HEADER) };
}

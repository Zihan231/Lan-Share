/**
 * Identity and signing.
 *
 * Pure-JS Ed25519 / SHA-256 (noble) is used instead of WebCrypto because `crypto.subtle`
 * is unavailable on plain-HTTP LAN origins (http://192.168.x.x is not a secure context).
 * The same code therefore works over HTTP and HTTPS.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { fromB64u, toB64u, utf8 } from './encoding.js';

export interface KeyPair {
  secretKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Cryptographically secure 128-bit identifier, base64url (22 chars). */
export function randomId(): string {
  return toB64u(randomBytes(16));
}

export function generateKeyPair(): KeyPair {
  const secretKey = ed25519.utils.randomPrivateKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** A peer ID is derived from its public key, so it cannot be claimed without the private key. */
export function peerIdFromPublicKey(publicKey: Uint8Array | string): string {
  const pk = typeof publicKey === 'string' ? fromB64u(publicKey) : publicKey;
  return toB64u(sha256(pk).subarray(0, 16));
}

/** Short human-comparable code, e.g. "7F3A-91C2-04BE". */
export function fingerprintOf(publicKey: Uint8Array | string): string {
  const pk = typeof publicKey === 'string' ? fromB64u(publicKey) : publicKey;
  const h = sha256(pk);
  let hex = '';
  for (let i = 0; i < 6; i++) hex += h[i].toString(16).padStart(2, '0');
  return hex.toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}

export function sign(message: string | Uint8Array, secretKey: Uint8Array): string {
  return toB64u(ed25519.sign(typeof message === 'string' ? utf8(message) : message, secretKey));
}

export function verify(sig: string, message: string | Uint8Array, publicKey: Uint8Array | string): boolean {
  try {
    const pk = typeof publicKey === 'string' ? fromB64u(publicKey) : publicKey;
    return ed25519.verify(fromB64u(sig), typeof message === 'string' ? utf8(message) : message, pk);
  } catch {
    return false;
  }
}

export { sha256 };

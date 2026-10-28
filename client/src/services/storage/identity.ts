import { fingerprintOf, fromB64u, generateKeyPair, peerIdFromPublicKey, toB64u } from '@lanshare/shared';
import type { Storage } from './db';

export interface Identity {
  peerId: string;
  publicKey: string; // base64url
  secretKey: Uint8Array;
  fingerprint: string;
}

interface Stored {
  sk: string;
  pk: string;
}

/**
 * Loads (or creates) this browser profile's long-term Ed25519 identity.
 * NOTE: browsers cannot protect a pure-JS key as "non-extractable"; anyone with access to this browser profile
 * can impersonate this user. That is inherent to the no-install, no-account design.
 */
export async function loadIdentity(db: Storage): Promise<Identity> {
  const stored = await db.get<Stored>('identity');
  if (stored) {
    try {
      const secretKey = fromB64u(stored.sk);
      if (secretKey.length === 32 && fromB64u(stored.pk).length === 32) {
        return { peerId: peerIdFromPublicKey(stored.pk), publicKey: stored.pk, secretKey, fingerprint: fingerprintOf(stored.pk) };
      }
    } catch {
      /* fall through and regenerate */
    }
  }
  const kp = generateKeyPair();
  const pk = toB64u(kp.publicKey);
  await db.set('identity', { sk: toB64u(kp.secretKey), pk } satisfies Stored);
  return { peerId: peerIdFromPublicKey(kp.publicKey), publicKey: pk, secretKey: kp.secretKey, fingerprint: fingerprintOf(kp.publicKey) };
}

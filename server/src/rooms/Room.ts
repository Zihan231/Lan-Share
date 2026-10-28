import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { PeerInfo } from '@lanshare/shared';

export interface Member extends PeerInfo {
  socketId: string;
  joinedAt: number;
}

export interface PendingJoin {
  peer: PeerInfo;
  socketId: string;
  resolve: (allow: boolean) => void;
  timer: NodeJS.Timeout;
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

/** In-memory room state. Nothing here is persisted: when the server stops, rooms cease to exist. */
export class Room {
  readonly members = new Map<string, Member>();
  readonly pending = new Map<string, PendingJoin>();
  /** Peers that were admitted once; they do not need approval again when they refresh. */
  readonly admitted = new Set<string>();
  adminId = '';
  private pw?: { salt: Buffer; hash: Buffer };

  constructor(
    readonly id: string,
    password: string | undefined,
    readonly requireApproval: boolean,
  ) {
    if (password) {
      const salt = randomBytes(16);
      this.pw = { salt, hash: hashPassword(password, salt) };
    }
  }

  get hasPassword(): boolean {
    return !!this.pw;
  }

  checkPassword(candidate: string | undefined): 'ok' | 'required' | 'bad' {
    if (!this.pw) return 'ok';
    if (!candidate) return 'required';
    const h = hashPassword(candidate, this.pw.salt);
    return timingSafeEqual(h, this.pw.hash) ? 'ok' : 'bad';
  }

  peersExcept(peerId: string): PeerInfo[] {
    return [...this.members.values()].filter((m) => m.peerId !== peerId).map(({ peerId: p, name, publicKey }) => ({ peerId: p, name, publicKey }));
  }

  /** Oldest remaining member becomes admin. */
  electAdmin(): string {
    let best: Member | undefined;
    for (const m of this.members.values()) if (!best || m.joinedAt < best.joinedAt) best = m;
    this.adminId = best?.peerId ?? '';
    return this.adminId;
  }
}

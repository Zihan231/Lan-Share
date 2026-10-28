import type { PeerInfo, PeerMsg, SignalPayload } from '@lanshare/shared';
import type { LinkChannel } from './channel';
import { PeerSession, type RtcPc, type SessionSelf, type SessionState, type SessionTiming } from './PeerSession';

export interface MeshHooks {
  sendSignal(to: string, payload: SignalPayload): boolean;
  createPc(): RtcPc;
  /** Peer connection state changed (connecting → authenticating → connected → closed/retrying). */
  onPeerState(peerId: string, state: PeerConnState, detail?: string): void;
  onPeerReady(session: PeerSession): void;
  onPeerGone(peerId: string, reason: string): void;
  onMessage(session: PeerSession, msg: PeerMsg): void;
  onXferChannel(session: PeerSession, ch: LinkChannel, transferId: string): void;
}

export type PeerConnState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'offline';

export const DEFAULT_TIMING: SessionTiming = { authTimeoutMs: 20_000, heartbeatMs: 5_000, deadAfterMs: 16_000 };
const BACKOFF = [500, 1500, 3000, 6000, 10_000, 15_000];

/**
 * Maintains a full mesh: one PeerSession per remote peer listed by signaling.
 *
 * Glare is avoided deterministically: the peer with the lexicographically smaller ID is the initiator
 * (creates the offer); the other side only ever answers. A new offer always replaces an older session.
 */
export class Mesh {
  private sessions = new Map<string, PeerSession>();
  private known = new Map<string, PeerInfo>();
  private attempts = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly self: SessionSelf,
    private readonly hooks: MeshHooks,
    private readonly timing: SessionTiming = DEFAULT_TIMING,
  ) {}

  get sessionList(): PeerSession[] {
    return [...this.sessions.values()];
  }
  session(peerId: string): PeerSession | undefined {
    return this.sessions.get(peerId);
  }
  ready(): PeerSession[] {
    return this.sessionList.filter((s) => s.ready);
  }
  knownPeers(): PeerInfo[] {
    return [...this.known.values()];
  }

  private isInitiator(peerId: string): boolean {
    return this.self.peerId < peerId;
  }

  /** Signaling handed us the authoritative member list (after join or re-join). */
  reconcile(peers: PeerInfo[]) {
    const ids = new Set(peers.map((p) => p.peerId));
    // Forget peers that are neither listed nor connected; keep healthy sessions alive across signaling outages.
    for (const id of [...this.known.keys()]) {
      if (!ids.has(id) && !this.sessions.get(id)?.ready) this.removePeer(id, 'not-in-room');
    }
    for (const p of peers) this.addPeer(p);
  }

  addPeer(info: PeerInfo) {
    if (this.disposed || info.peerId === this.self.peerId) return;
    const prev = this.known.get(info.peerId);
    this.known.set(info.peerId, info);
    const existing = this.sessions.get(info.peerId);
    if (existing) {
      if (prev && prev.publicKey !== info.publicKey) existing.close('key-changed');
      else if (existing.ready) existing.probe(); // peer re-joined signaling: make sure the old session is truly alive
      return;
    }
    this.hooks.onPeerState(info.peerId, 'connecting');
    this.ensure(info.peerId);
  }

  removePeer(peerId: string, reason = 'left') {
    this.known.delete(peerId);
    this.attempts.delete(peerId);
    const t = this.retryTimers.get(peerId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(peerId);
    const s = this.sessions.get(peerId);
    if (s) s.close('removed:' + reason);
    else this.hooks.onPeerGone(peerId, reason);
  }

  /** (Re)try every known peer that has no live session, e.g. after signaling came back. */
  retryAll() {
    for (const id of this.known.keys()) {
      const s = this.sessions.get(id);
      if (!s || s.state === 'closed') {
        this.attempts.set(id, 0);
        this.ensure(id);
      }
    }
  }

  /** Initiators create an offer; responders wait for one. */
  private ensure(peerId: string) {
    const info = this.known.get(peerId);
    if (!info || this.disposed || this.sessions.has(peerId)) return;
    if (!this.isInitiator(peerId)) return;
    this.createSession(info, 'initiator');
  }

  private createSession(info: PeerInfo, role: 'initiator' | 'responder'): PeerSession {
    const session = new PeerSession(
      info,
      role,
      this.hooks.createPc(),
      this.self,
      {
        sendSignal: (to, payload) => void this.hooks.sendSignal(to, payload),
        onState: (s) => this.onSessionState(s),
        onMessage: (s, m) => this.hooks.onMessage(s, m),
        onXferChannel: (s, ch, id) => this.hooks.onXferChannel(s, ch, id),
        onClosed: (s, reason) => this.onSessionClosed(s, reason),
      },
      this.timing,
    );
    this.sessions.set(info.peerId, session);
    void session.start().catch((e) => session.close('start-failed:' + (e instanceof Error ? e.message : String(e))));
    return session;
  }

  private onSessionState(s: PeerSession) {
    if (this.sessions.get(s.peerId) !== s) return;
    if (s.state === 'connected') {
      this.attempts.set(s.peerId, 0);
      this.hooks.onPeerState(s.peerId, 'connected');
      this.hooks.onPeerReady(s);
    } else if (s.state === 'authenticating' || s.state === 'connecting') {
      this.hooks.onPeerState(s.peerId, 'connecting');
    }
  }

  private onSessionClosed(s: PeerSession, reason: string) {
    if (this.sessions.get(s.peerId) !== s) return; // a replaced session closing must not affect its successor
    this.sessions.delete(s.peerId);
    const stillKnown = this.known.has(s.peerId) && !reason.startsWith('removed:') && !this.disposed;
    this.hooks.onPeerGone(s.peerId, reason);
    if (!stillKnown) return;
    const n = (this.attempts.get(s.peerId) ?? 0) + 1;
    this.attempts.set(s.peerId, n);
    this.hooks.onPeerState(s.peerId, n > BACKOFF.length ? 'failed' : 'reconnecting', reason);
    if (this.isInitiator(s.peerId)) {
      const delay = BACKOFF[Math.min(n - 1, BACKOFF.length - 1)];
      const t = setTimeout(() => {
        this.retryTimers.delete(s.peerId);
        this.ensure(s.peerId);
      }, delay);
      this.retryTimers.set(s.peerId, t);
    }
  }

  handleSignal(from: string, payload: SignalPayload) {
    if (this.disposed) return;
    const info = this.known.get(from);
    if (!info) return; // only talk to peers signaling listed in our room
    if (payload.kind === 'offer') {
      if (this.isInitiator(from)) return; // glare protection: we are the offerer for this pair
      const old = this.sessions.get(from);
      if (old) {
        this.sessions.delete(from); // replace silently so its close does not trigger a retry
        old.close('replaced');
      }
      const s = this.createSession(info, 'responder');
      void s.handleSignal(payload);
      return;
    }
    void this.sessions.get(from)?.handleSignal(payload);
  }

  send(peerId: string, msg: PeerMsg): boolean {
    const s = this.sessions.get(peerId);
    if (!s?.ready) return false;
    s.send(msg);
    return true;
  }

  broadcast(msg: PeerMsg, except?: string) {
    for (const s of this.sessions.values()) if (s.ready && s.peerId !== except) s.send(msg);
  }

  stateOf(peerId: string): SessionState | 'none' {
    return this.sessions.get(peerId)?.state ?? 'none';
  }

  dispose() {
    this.disposed = true;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const s of [...this.sessions.values()]) s.close('removed:dispose');
    this.sessions.clear();
    this.known.clear();
  }
}

import {
  PROTOCOL_VERSION,
  authMessage,
  fingerprintOf,
  isId,
  peerIdFromPublicKey,
  randomId,
  sanitizeName,
  sign,
  verify,
  type PeerInfo,
  type PeerMsg,
  type SignalPayload,
} from '@lanshare/shared';
import { drain, type LinkChannel } from './channel';
import { Reassembler, encodeMessage } from './framing';

/** The subset of RTCPeerConnection used here (also implemented by the test fake). */
export interface RtcPc {
  readonly localDescription: { sdp: string } | null;
  readonly remoteDescription: { sdp: string } | null;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  createDataChannel(label: string, init?: { ordered?: boolean }): LinkChannel;
  createOffer(): Promise<{ type: 'offer'; sdp?: string }>;
  createAnswer(): Promise<{ type: 'answer'; sdp?: string }>;
  setLocalDescription(desc?: { type: 'offer' | 'answer'; sdp?: string }): Promise<void>;
  setRemoteDescription(desc: { type: 'offer' | 'answer'; sdp: string }): Promise<void>;
  addIceCandidate(c: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }): Promise<void>;
  close(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onicecandidate: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ondatachannel: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onconnectionstatechange: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oniceconnectionstatechange: ((ev: any) => void) | null;
}

export type SessionState = 'connecting' | 'authenticating' | 'connected' | 'closed';

export interface SessionSelf {
  peerId: string;
  publicKey: string;
  secretKey: Uint8Array;
  getName(): string;
}

export interface SessionTiming {
  authTimeoutMs: number;
  heartbeatMs: number;
  deadAfterMs: number;
}

export interface SessionHooks {
  sendSignal(to: string, payload: SignalPayload): void;
  onState(session: PeerSession): void;
  onMessage(session: PeerSession, msg: PeerMsg): void;
  onXferChannel(session: PeerSession, ch: LinkChannel, transferId: string): void;
  onClosed(session: PeerSession, reason: string): void;
}

const MSG_TYPES = new Set([
  'hello', 'auth', 'ping', 'pong', 'profile', 'record', 'ack', 'sync-have', 'sync-records',
  'files-have', 'file-request', 'file-queued', 'file-reject', 'xfer-cancel',
]);

function fingerprintFromSdp(sdp: string | undefined): string | null {
  const m = sdp && /a=fingerprint:\S+ ([0-9A-Fa-f:]+)/.exec(sdp);
  return m ? m[1].toUpperCase() : null;
}

/**
 * One WebRTC connection to one remote peer.
 *
 *  - "ctl" DataChannel: authenticated JSON control messages (chat records, sync, availability, requests).
 *  - "xfer:<id>" DataChannels: one per file transfer, opened by the sending side.
 *
 * Authentication: both sides exchange a nonce and sign (nonce, own DTLS fingerprint, peer DTLS fingerprint)
 * with their long-term Ed25519 key. Because the signature covers the DTLS fingerprints, a relaying
 * (malicious) signaling server cannot splice two sessions together, and the peer ID (hash of the key)
 * cannot be claimed without the private key.
 */
export class PeerSession {
  state: SessionState = 'connecting';
  name: string;
  readonly createdAt = Date.now();
  lastSeen = Date.now();
  private ctl: LinkChannel | null = null;
  private reasm = new Reassembler();
  private pendingCandidates: Array<Extract<SignalPayload, { kind: 'candidate' }>> = [];
  private remoteSet = false;
  private myNonce = randomId();
  private remoteNonce: string | null = null;
  private sentAuth = false;
  private remoteVerified = false;
  private timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  private sendQueue: Promise<void> = Promise.resolve();
  private pingN = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly fingerprint: string;
  closeReason = '';

  constructor(
    readonly info: PeerInfo,
    readonly role: 'initiator' | 'responder',
    private readonly pc: RtcPc,
    private readonly self: SessionSelf,
    private readonly hooks: SessionHooks,
    private readonly timing: SessionTiming,
  ) {
    this.name = info.name;
    this.fingerprint = fingerprintOf(info.publicKey);
  }

  get peerId(): string {
    return this.info.peerId;
  }
  get ready(): boolean {
    return this.state === 'connected';
  }

  // --------------------------------------------------------------------------------------------
  // Negotiation
  // --------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.wirePc();
    this.timers.push(setTimeout(() => this.state !== 'connected' && this.close('auth-timeout'), this.timing.authTimeoutMs));
    if (this.role === 'initiator') {
      this.setCtl(this.pc.createDataChannel('ctl', { ordered: true }));
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.hooks.sendSignal(this.peerId, { kind: 'offer', sdp: this.pc.localDescription?.sdp ?? offer.sdp ?? '' });
    }
  }

  async handleSignal(p: SignalPayload): Promise<void> {
    if (this.state === 'closed') return;
    try {
      if (p.kind === 'offer' && this.role === 'responder') {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
        await this.flushCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.hooks.sendSignal(this.peerId, { kind: 'answer', sdp: this.pc.localDescription?.sdp ?? answer.sdp ?? '' });
      } else if (p.kind === 'answer' && this.role === 'initiator') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
        await this.flushCandidates();
      } else if (p.kind === 'candidate') {
        if (!this.remoteSet) this.pendingCandidates.push(p);
        else await this.pc.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex });
      }
    } catch (e) {
      this.close('negotiation-error:' + (e instanceof Error ? e.message : String(e)));
    }
  }

  private async flushCandidates() {
    this.remoteSet = true;
    const q = this.pendingCandidates.splice(0);
    for (const c of q) {
      try {
        await this.pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
      } catch {
        /* a stale/invalid candidate must not kill the session */
      }
    }
  }

  private wirePc() {
    this.pc.onicecandidate = (ev) => {
      const c = ev.candidate;
      if (c && c.candidate) this.hooks.sendSignal(this.peerId, { kind: 'candidate', candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
    };
    this.pc.ondatachannel = (ev) => {
      const ch = ev.channel as LinkChannel;
      if (ch.label === 'ctl' && !this.ctl && this.role === 'responder') {
        this.setCtl(ch);
      } else if (ch.label.startsWith('xfer:') && this.ready) {
        const id = ch.label.slice(5);
        if (!isId(id)) return ch.close();
        ch.binaryType = 'arraybuffer';
        this.hooks.onXferChannel(this, ch, id);
      } else {
        ch.close();
      }
    };
    const check = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close('ice-' + s);
      else if (s === 'disconnected') {
        // Often transient (Wi-Fi roam). Give ICE a few seconds to recover before tearing down.
        const t = setTimeout(() => {
          if (this.pc.connectionState === 'disconnected') this.close('ice-disconnected');
        }, 6000);
        this.timers.push(t);
      }
    };
    this.pc.onconnectionstatechange = check;
  }

  private setCtl(ch: LinkChannel) {
    this.ctl = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 256 * 1024;
    ch.onopen = () => this.onCtlOpen();
    ch.onclose = () => this.close('channel-closed');
    ch.onerror = () => this.close('channel-error');
    ch.onmessage = (ev) => this.onRaw(ev.data);
    if (ch.readyState === 'open') this.onCtlOpen();
  }

  // --------------------------------------------------------------------------------------------
  // Handshake
  // --------------------------------------------------------------------------------------------

  private onCtlOpen() {
    if (this.state !== 'connecting') return;
    this.state = 'authenticating';
    this.hooks.onState(this);
    this.sendNow({ t: 'hello', peerId: this.self.peerId, key: this.self.publicKey, name: this.self.getName(), nonce: this.myNonce, v: PROTOCOL_VERSION });
  }

  private onHello(m: Extract<PeerMsg, { t: 'hello' }>) {
    if (this.remoteNonce) return; // only one hello per session
    const ok =
      m.v === PROTOCOL_VERSION &&
      m.peerId === this.peerId &&
      m.key === this.info.publicKey &&
      typeof m.nonce === 'string' && m.nonce.length >= 16 && m.nonce.length <= 44 &&
      peerIdFromPublicKey(m.key) === m.peerId;
    if (!ok) return this.close('bad-hello');
    this.name = sanitizeName(m.name, this.name);
    this.remoteNonce = m.nonce;
    const local = fingerprintFromSdp(this.pc.localDescription?.sdp);
    const remote = fingerprintFromSdp(this.pc.remoteDescription?.sdp);
    if (!local || !remote) return this.close('no-fingerprint');
    this.sendNow({ t: 'auth', sig: sign(authMessage(m.nonce, local, remote), this.self.secretKey) });
    this.sentAuth = true;
    this.maybeReady();
  }

  private onAuth(m: Extract<PeerMsg, { t: 'auth' }>) {
    if (this.remoteVerified || typeof m.sig !== 'string') return;
    const local = fingerprintFromSdp(this.pc.localDescription?.sdp);
    const remote = fingerprintFromSdp(this.pc.remoteDescription?.sdp);
    if (!local || !remote || !verify(m.sig, authMessage(this.myNonce, remote, local), this.info.publicKey)) return this.close('auth-failed');
    this.remoteVerified = true;
    this.maybeReady();
  }

  private maybeReady() {
    if (this.state !== 'authenticating' || !this.sentAuth || !this.remoteVerified) return;
    this.state = 'connected';
    this.lastSeen = Date.now();
    this.startHeartbeat();
    this.hooks.onState(this);
  }

  // --------------------------------------------------------------------------------------------
  // Messaging
  // --------------------------------------------------------------------------------------------

  private onRaw(data: unknown) {
    if (typeof data !== 'string') return; // ctl is text only
    this.lastSeen = Date.now();
    let msg: unknown;
    try {
      msg = this.reasm.push(data);
    } catch {
      return this.close('protocol-error');
    }
    if (msg === undefined) return;
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string' || !MSG_TYPES.has((msg as { t: string }).t)) return;
    const m = msg as PeerMsg;
    if (m.t === 'hello') return this.onHello(m);
    if (m.t === 'auth') return this.onAuth(m);
    if (!this.ready) return; // nothing else is accepted before mutual authentication
    if (m.t === 'ping') return this.sendNow({ t: 'pong', n: m.n });
    if (m.t === 'pong') {
      if (this.probeTimer) clearTimeout(this.probeTimer);
      this.probeTimer = null;
      return;
    }
    if (m.t === 'profile') {
      this.name = sanitizeName(m.name, this.name);
    }
    this.hooks.onMessage(this, m);
  }

  private sendNow(msg: PeerMsg) {
    for (const part of encodeMessage(msg)) this.rawSend(part);
  }

  private rawSend(part: string) {
    try {
      if (this.ctl?.readyState === 'open') this.ctl.send(part);
    } catch {
      this.close('send-failed');
    }
  }

  /** Queue a control message. Large messages are fragmented and the send buffer is respected. */
  send(msg: PeerMsg): void {
    if (!this.ready) return;
    const parts = encodeMessage(msg);
    this.sendQueue = this.sendQueue.then(async () => {
      for (const p of parts) {
        if (this.state === 'closed' || !this.ctl) return;
        await drain(this.ctl, 1024 * 1024);
        this.rawSend(p);
      }
    });
  }

  openTransferChannel(transferId: string): LinkChannel | null {
    if (!this.ready) return null;
    const ch = this.pc.createDataChannel('xfer:' + transferId, { ordered: true });
    ch.binaryType = 'arraybuffer';
    return ch;
  }

  private startHeartbeat() {
    this.timers.push(
      setInterval(() => {
        if (this.state !== 'connected') return;
        if (Date.now() - this.lastSeen > this.timing.deadAfterMs) return this.close('heartbeat-timeout');
        this.sendNow({ t: 'ping', n: ++this.pingN });
      }, this.timing.heartbeatMs),
    );
  }

  /** Verify liveness quickly (used when the signaling server says the peer re-joined). */
  probe(timeoutMs = 2500) {
    if (!this.ready || this.probeTimer) return;
    this.sendNow({ t: 'ping', n: ++this.pingN });
    this.probeTimer = setTimeout(() => this.close('probe-timeout'), timeoutMs);
  }

  close(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeReason = reason;
    for (const t of this.timers) {
      clearTimeout(t as ReturnType<typeof setTimeout>);
      clearInterval(t as ReturnType<typeof setInterval>);
    }
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.timers = [];
    this.reasm.reset();
    try {
      this.ctl?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.hooks.onClosed(this, reason);
  }
}

import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  joinMessage,
  type ClientToServerEvents,
  type JoinAck,
  type JoinError,
  type PeerInfo,
  type ServerToClientEvents,
  type SignalPayload,
} from '@lanshare/shared';

export type SignalingStatus = 'connecting' | 'connected' | 'disconnected';

export interface JoinParams {
  roomId: string;
  peerId: string;
  publicKey: string;
  name: string;
  password?: string;
  requireApproval?: boolean;
  /** Signs the server-issued challenge. */
  sign(message: string): string;
}

export interface SignalingHandlers {
  onStatus(status: SignalingStatus): void;
  onJoined(ack: Extract<JoinAck, { ok: true }>, isRejoin: boolean): void;
  onJoinFailed(error: JoinError | 'connect-failed'): void;
  onAwaitingApproval(): void;
  onPeerJoined(peer: PeerInfo): void;
  onPeerLeft(peerId: string): void;
  onPeerRenamed(peerId: string, name: string): void;
  onSignal(from: string, payload: SignalPayload): void;
  onJoinRequest(peer: PeerInfo): void;
  onJoinRequestCancelled(peerId: string): void;
  onAdmin(peerId: string): void;
  onReplaced(): void;
}

/**
 * Thin Socket.IO wrapper. It joins with a signed challenge, keeps trying to reconnect with backoff, and
 * transparently re-joins after the server restarts or the network flaps. P2P sessions are managed elsewhere and
 * are not torn down when this connection drops.
 */
export class SignalingClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private params: JoinParams | null = null;
  private joinedOnce = false;
  private stopped = false;

  constructor(
    private readonly h: SignalingHandlers,
    private readonly url?: string,
  ) {}

  connect(params: JoinParams) {
    this.params = params;
    this.stopped = false;
    this.h.onStatus('connecting');
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(this.url ?? '/', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 8000,
    });
    this.socket = socket;

    socket.on('challenge', (nonce) => this.join(nonce));
    socket.on('disconnect', () => {
      if (!this.stopped) this.h.onStatus('disconnected');
    });
    socket.on('connect_error', () => {
      if (!this.stopped) this.h.onStatus(this.joinedOnce ? 'disconnected' : 'connecting');
    });
    socket.on('peer-joined', (p) => this.h.onPeerJoined(p));
    socket.on('peer-left', (id) => this.h.onPeerLeft(id));
    socket.on('peer-renamed', (id, n) => this.h.onPeerRenamed(id, n));
    socket.on('signal', (from, payload) => this.h.onSignal(from, payload));
    socket.on('join-request', (p) => this.h.onJoinRequest(p));
    socket.on('join-request-cancelled', (id) => this.h.onJoinRequestCancelled(id));
    socket.on('admin', (id) => this.h.onAdmin(id));
    socket.on('replaced', () => {
      this.stopped = true;
      socket.disconnect();
      this.h.onReplaced();
    });
  }

  private join(nonce: string) {
    const p = this.params;
    const s = this.socket;
    if (!p || !s || this.stopped) return;
    const approvalTimer = setTimeout(() => this.h.onAwaitingApproval(), 1200);
    s.emit(
      'join',
      {
        roomId: p.roomId,
        peerId: p.peerId,
        publicKey: p.publicKey,
        name: p.name,
        password: p.password,
        requireApproval: p.requireApproval,
        sig: p.sign(joinMessage(p.roomId, nonce)),
        protocol: PROTOCOL_VERSION,
      },
      (ack) => {
        clearTimeout(approvalTimer);
        if (this.stopped) return;
        if (ack.ok) {
          const rejoin = this.joinedOnce;
          this.joinedOnce = true;
          this.h.onStatus('connected');
          this.h.onJoined(ack, rejoin);
        } else {
          if (ack.error !== 'rate-limited') this.stopped = true; // wrong password / denied: stop retrying
          if (this.stopped) s.disconnect();
          this.h.onJoinFailed(ack.error);
        }
      },
    );
  }

  signal(to: string, payload: SignalPayload): boolean {
    if (!this.socket?.connected || !this.joinedOnce) return false;
    this.socket.emit('signal', to, payload);
    return true;
  }
  decide(peerId: string, allow: boolean) {
    this.socket?.emit('decide', peerId, allow);
  }
  rename(name: string) {
    if (this.params) this.params.name = name;
    this.socket?.emit('rename', name);
  }

  close() {
    this.stopped = true;
    try {
      this.socket?.emit('leave');
    } catch {
      /* ignore */
    }
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.joinedOnce = false;
  }
}

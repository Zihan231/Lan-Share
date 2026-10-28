import type http from 'node:http';
import type https from 'node:https';
import { Server, type Socket } from 'socket.io';
import {
  PROTOCOL_VERSION,
  fromB64u,
  joinMessage,
  peerIdFromPublicKey,
  randomId,
  sanitizeName,
  validateRoomId,
  validateSignal,
  verify,
  type ClientToServerEvents,
  type JoinAck,
  type JoinRequest,
  type ServerToClientEvents,
} from '@lanshare/shared';
import type { ServerConfig } from '../config.js';
import { RateLimiter } from '../middleware/rateLimit.js';
import { Room, type Member } from '../rooms/Room.js';

type S = Socket<ClientToServerEvents, ServerToClientEvents>;

interface SocketState {
  nonce: string;
  ip: string;
  roomId?: string;
  peerId?: string;
}

export interface SignalingServer {
  io: Server<ClientToServerEvents, ServerToClientEvents>;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

/**
 * Attaches the signaling service to one or more HTTP(S) servers.
 *
 * Responsibilities: authenticated presence (who is in the room), optional password / approval gate,
 * and relaying WebRTC offers/answers/ICE candidates between members of the same room.
 * It never sees file contents or chat messages: those travel peer-to-peer over DataChannels.
 */
export function attachSignaling(servers: Array<http.Server | https.Server>, cfg: ServerConfig): SignalingServer {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>({
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 4000,
    pingTimeout: 6000,
    serveClient: false,
    cors: undefined,
  });
  for (const s of servers) io.attach(s);

  const rooms = new Map<string, Room>();
  const joinLimiter = new RateLimiter(cfg.joinsPerMinute, 60_000);
  const signalLimiter = new RateLimiter(400, 10_000);
  const state = new WeakMap<S, SocketState>();

  const sockOf = (id: string): S | undefined => io.sockets.sockets.get(id) as S | undefined;
  const emitToRoom = (room: Room, fn: (m: Member, s: S) => void, exceptPeer?: string) => {
    for (const m of room.members.values()) {
      if (m.peerId === exceptPeer) continue;
      const s = sockOf(m.socketId);
      if (s) fn(m, s);
    }
  };

  function removeMember(room: Room, peerId: string, socketId: string) {
    const m = room.members.get(peerId);
    if (!m || m.socketId !== socketId) return;
    room.members.delete(peerId);
    const wasAdmin = room.adminId === peerId;
    emitToRoom(room, (_m, s) => s.emit('peer-left', peerId));
    if (wasAdmin) {
      const next = room.electAdmin();
      if (next) {
        emitToRoom(room, (_m, s) => s.emit('admin', next));
        // Re-route pending approval requests to the new admin.
        const adminSock = sockOf(room.members.get(next)!.socketId);
        for (const p of room.pending.values()) adminSock?.emit('join-request', p.peer);
      }
    }
    if (room.members.size === 0) {
      for (const p of room.pending.values()) {
        clearTimeout(p.timer);
        p.resolve(false);
      }
      rooms.delete(room.id);
    }
  }

  function leave(s: S) {
    const st = state.get(s);
    if (!st) return;
    const room = st.roomId ? rooms.get(st.roomId) : undefined;
    if (room && st.peerId) {
      const p = room.pending.get(st.peerId);
      if (p && p.socketId === s.id) {
        clearTimeout(p.timer);
        room.pending.delete(st.peerId);
        const admin = room.members.get(room.adminId);
        if (admin) sockOf(admin.socketId)?.emit('join-request-cancelled', st.peerId);
      }
      removeMember(room, st.peerId, s.id);
    }
    st.roomId = undefined;
    st.peerId = undefined;
  }

  io.on('connection', (socket: S) => {
    const ip = socket.handshake.address;
    const st: SocketState = { nonce: randomId(), ip };
    state.set(socket, st);
    socket.emit('challenge', st.nonce);

    socket.on('join', async (req: JoinRequest, ack: (res: JoinAck) => void) => {
      if (typeof ack !== 'function') return;
      const fail = (error: Extract<JoinAck, { ok: false }>['error']) => ack({ ok: false, error });
      try {
        if (!joinLimiter.take(ip)) return fail('rate-limited');
        if (st.roomId) return fail('invalid');
        if (
          !req ||
          typeof req !== 'object' ||
          req.protocol !== PROTOCOL_VERSION ||
          !validateRoomId(req.roomId) ||
          typeof req.publicKey !== 'string' ||
          req.publicKey.length !== 43 ||
          typeof req.sig !== 'string' ||
          (req.password !== undefined && (typeof req.password !== 'string' || req.password.length > 128))
        ) {
          return fail('invalid');
        }
        let pubOk = false;
        try {
          pubOk = fromB64u(req.publicKey).length === 32 && peerIdFromPublicKey(req.publicKey) === req.peerId;
        } catch {
          /* invalid */
        }
        if (!pubOk) return fail('invalid');
        // Proof of private-key possession, bound to this connection's nonce: prevents peer-ID impersonation.
        if (!verify(req.sig, joinMessage(req.roomId, st.nonce), req.publicKey)) return fail('bad-signature');

        const name = sanitizeName(req.name);
        let room = rooms.get(req.roomId);
        if (!room) {
          if (rooms.size >= cfg.maxRooms) return fail('rate-limited');
          room = new Room(req.roomId, cfg.roomPassword ?? (req.password || undefined), cfg.requireApproval || !!req.requireApproval);
          rooms.set(room.id, room);
        } else {
          const pw = room.checkPassword(req.password);
          if (pw === 'required') return fail('password-required');
          if (pw === 'bad') return fail('bad-password');
        }
        if (room.members.size >= cfg.maxPeersPerRoom && !room.members.has(req.peerId)) return fail('rate-limited');

        const peer = { peerId: req.peerId, name, publicKey: req.publicKey };
        st.roomId = room.id;
        st.peerId = req.peerId;

        const needsApproval = room.requireApproval && room.members.size > 0 && !room.admitted.has(req.peerId);
        if (needsApproval) {
          const adminSock = sockOf(room.members.get(room.adminId)?.socketId ?? '');
          const prev = room.pending.get(req.peerId);
          if (prev) {
            clearTimeout(prev.timer);
            prev.resolve(false);
          }
          const allowed = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              room!.pending.delete(req.peerId);
              resolve(false);
            }, cfg.approvalTimeoutMs);
            room!.pending.set(req.peerId, { peer, socketId: socket.id, resolve, timer });
            adminSock?.emit('join-request', peer);
          });
          room.pending.delete(req.peerId);
          if (!allowed || !socket.connected || !rooms.has(room.id)) {
            st.roomId = undefined;
            st.peerId = undefined;
            return fail(socket.connected ? 'denied' : 'approval-timeout');
          }
        }

        // Replace a stale session of the same identity (refresh / second tab).
        const old = room.members.get(req.peerId);
        if (old) {
          const oldSock = sockOf(old.socketId);
          room.members.delete(req.peerId);
          emitToRoom(room, (_m, s) => s.emit('peer-left', req.peerId));
          if (oldSock) {
            const ost = state.get(oldSock);
            if (ost) {
              ost.roomId = undefined;
              ost.peerId = undefined;
            }
            oldSock.emit('replaced');
          }
        }
        const others = room.peersExcept(req.peerId);
        room.members.set(req.peerId, { ...peer, socketId: socket.id, joinedAt: Date.now() });
        room.admitted.add(req.peerId);
        if (!room.adminId || !room.members.has(room.adminId)) room.electAdmin();
        emitToRoom(room, (_m, s) => s.emit('peer-joined', peer), req.peerId);
        ack({ ok: true, roomId: room.id, adminId: room.adminId, requireApproval: room.requireApproval, hasPassword: room.hasPassword, peers: others });
      } catch (e) {
        console.error('join failed', e);
        fail('invalid');
      }
    });

    socket.on('signal', (to, payload) => {
      if (!st.roomId || !st.peerId || typeof to !== 'string') return;
      if (!signalLimiter.take(socket.id)) return;
      const clean = validateSignal(payload);
      if (!clean) return;
      const room = rooms.get(st.roomId);
      const target = room?.members.get(to);
      if (!target || room?.members.get(st.peerId)?.socketId !== socket.id) return;
      sockOf(target.socketId)?.emit('signal', st.peerId, clean);
    });

    socket.on('decide', (peerId, allow) => {
      if (!st.roomId || !st.peerId || typeof peerId !== 'string') return;
      const room = rooms.get(st.roomId);
      if (!room || room.adminId !== st.peerId) return;
      const p = room.pending.get(peerId);
      if (!p) return;
      clearTimeout(p.timer);
      room.pending.delete(peerId);
      p.resolve(!!allow);
      if (allow) room.admitted.add(peerId);
    });

    socket.on('rename', (name) => {
      if (!st.roomId || !st.peerId) return;
      const room = rooms.get(st.roomId);
      const m = room?.members.get(st.peerId);
      if (!room || !m) return;
      m.name = sanitizeName(name);
      emitToRoom(room, (_m, s) => s.emit('peer-renamed', m.peerId, m.name), m.peerId);
    });

    socket.on('leave', () => leave(socket));
    socket.on('disconnect', () => leave(socket));
  });

  return {
    io,
    rooms,
    async close() {
      joinLimiter.dispose();
      signalLimiter.dispose();
      await io.close();
    },
  };
}

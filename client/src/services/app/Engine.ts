import {
  DEFAULT_ROOM_ID,
  LIMITS,
  fingerprintOf,
  isId,
  randomId,
  sanitizeFileName,
  sanitizeName,
  sign,
  signRecord,
  validateRecord,
  validateRoomId,
  type FileMeta,
  type PeerInfo,
  type PeerMsg,
  type RoomConfigUpdate,
  type RoomRecord,
  type UnsignedRecord,
} from '@lanshare/shared';
import { DEFAULT_SETTINGS, type Settings, type TransferView, type UiPeer, type FileAvailability } from '../../types';
import { get, set, useApp, type Toast } from '../../stores/app';
import { guessMime } from '../../utils/format';
import { makeThumbnail, saveBlob } from '../../utils/files';
import { Storage, requestPersistence, storageEstimate, type ReplicaRecord } from '../storage/db';
import { loadIdentity, type Identity } from '../storage/identity';
import { SignalingClient, type SignalingHandlers } from '../signaling/SignalingClient';
import { RecordStore, batchRecords } from '../sync/RecordStore';
import { FileRegistry } from '../transfers/FileRegistry';
import { hashFile } from '../transfers/hashFile';
import { DiskSink, StoreSink, type Sink } from '../transfers/sinks';
import { TransferManager, type TransferHost } from '../transfers/TransferManager';
import type { PeerSession, RtcPc } from '../webrtc/PeerSession';
import { Mesh } from '../webrtc/Mesh';

const MB = 1024 * 1024;
const SYNC_CAP = 5000;

export interface JoinOptions {
  name: string;
  roomId: string;
  password?: string;
  requireApproval?: boolean;
}

export interface PickedFile {
  file: File;
  handle?: FileSystemFileHandle;
}

const profileParam = (): string => {
  try {
    return (new URLSearchParams(location.search).get('profile') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  } catch {
    return '';
  }
};

/**
 * Application controller: wires signaling, the WebRTC mesh, the synchronised record log, the file registry and
 * the transfer manager together and publishes UI state into the zustand store. The UI only calls methods here.
 */
export class Engine {
  storage!: Storage;
  identity!: Identity;
  registry!: FileRegistry;
  private records: RecordStore | null = null;
  private mesh: Mesh | null = null;
  private signaling: SignalingClient | null = null;
  private transfers: TransferManager | null = null;
  private roomId = '';
  private peerFiles = new Map<string, Set<string>>();
  private rates = new Map<string, number[]>();
  private lastTs = 0;
  private trusted = new Set<string>();
  private hidden = new Set<string>();
  private downloading = new Set<string>();
  private availQueued = false;
  private booted = false;

  // ============================================================================================
  // Boot / join / leave
  // ============================================================================================

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    try {
      this.storage = await Storage.open(profileParam());
      this.identity = await loadIdentity(this.storage);
      const saved = (await this.storage.get<Partial<Settings>>('settings')) ?? {};
      const settings = { ...DEFAULT_SETTINGS, ...saved };
      this.trusted = new Set((await this.storage.get<string[]>('trusted')) ?? []);
      this.registry = new FileRegistry(this.storage);
      for (const r of await this.registry.loadReplicas()) if (r.temp) await this.storage.removeReplica(r.fileId);
      this.registry.onChange(() => this.scheduleAvail());
      set({
        identity: { peerId: this.identity.peerId, publicKey: this.identity.publicKey, fingerprint: this.identity.fingerprint },
        settings,
        name: (await this.storage.get<string>('name')) ?? '',
        phase: 'join',
        loaded: true,
      });
      void this.loadLanUrls();
      void this.refreshStorage();
      const sess = sessionStorage.getItem('lanshare.session');
      if (sess) {
        try {
          await this.join(JSON.parse(sess) as JoinOptions);
        } catch {
          sessionStorage.removeItem('lanshare.session');
        }
      }
    } catch (e) {
      set({ bootError: e instanceof Error ? e.message : String(e), phase: 'boot', loaded: true });
    }
  }

  private async loadLanUrls() {
    try {
      const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
      const secure = location.protocol === 'https:';
      const urls: string[] = secure ? info.urls.https : info.urls.http;
      set({
        lanUrls: [...urls, ...(secure ? info.urls.http : info.urls.https)],
        isHostDevice: typeof info.isHost === 'boolean' ? info.isHost : get().isHostDevice,
      });
    } catch {
      /* offline dev server: not critical */
    }
  }

  async join(o: JoinOptions): Promise<void> {
    this.teardown();
    const roomId = (o.roomId || DEFAULT_ROOM_ID).trim();
    const name = sanitizeName(o.name, '');
    if (!name) return set({ joinError: 'Please enter a display name.', phase: 'join' });
    if (!validateRoomId(roomId)) return set({ joinError: 'Room ID may only contain letters, numbers, "-" and "_".', phase: 'join' });
    set({ phase: 'joining', joinError: null, joinStatus: 'connecting', name, signaling: 'connecting' });
    await this.storage.set('name', name);
    try {
      sessionStorage.setItem('lanshare.session', JSON.stringify({ ...o, name, roomId }));
    } catch {
      /* private mode */
    }
    this.roomId = roomId;
    this.hidden = new Set((await this.storage.get<string[]>('hidden:' + roomId)) ?? []);
    const records = new RecordStore(roomId, this.storage, {
      clearedBefore: (await this.storage.get<number>('cleared:' + roomId)) ?? 0,
      adminIds: (await this.storage.get<string[]>('admins:' + roomId)) ?? [],
    });
    await records.load();
    this.records = records;
    records.subscribe(() => this.syncRecordsToStore());
    this.syncRecordsToStore();
    set({ hiddenIds: [...this.hidden], events: [], acks: {}, peers: {}, transfers: {}, joinRequests: [] });

    this.transfers = new TransferManager(this.transferHost());
    this.mesh = new Mesh(
      { peerId: this.identity.peerId, publicKey: this.identity.publicKey, secretKey: this.identity.secretKey, getName: () => get().name },
      {
        sendSignal: (to, payload) => this.signaling?.signal(to, payload) ?? false,
        createPc: () => new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 }) as unknown as RtcPc,
        onPeerState: (id, conn) => this.patchPeer(id, { conn }),
        onPeerReady: (s) => this.onPeerReady(s),
        onPeerGone: (id, reason) => {
          console.info(`[lanshare] peer session closed (${reason})`);
          this.onPeerGone(id);
        },
        onMessage: (s, m) => void this.onMessage(s, m),
        onXferChannel: (s, ch, id) => this.transfers?.handleIncomingChannel(s.peerId, ch, id),
      },
    );

    const id = this.identity;
    this.signaling = new SignalingClient(this.signalingHandlers());
    this.signaling.connect({
      roomId,
      peerId: id.peerId,
      publicKey: id.publicKey,
      name,
      password: o.password || undefined,
      requireApproval: o.requireApproval,
      sign: (m) => sign(m, id.secretKey),
    });
  }

  /** Leave the room (keeps local history). */
  leave() {
    try {
      sessionStorage.removeItem('lanshare.session');
    } catch {
      /* ignore */
    }
    this.teardown();
    set({ phase: 'join', room: null, peers: {}, joinStatus: 'idle', joinError: null });
  }

  private teardown() {
    this.signaling?.close();
    this.mesh?.dispose();
    this.transfers?.dispose();
    this.signaling = null;
    this.mesh = null;
    this.transfers = null;
    this.records = null;
    this.peerFiles.clear();
    this.rates.clear();
    this.downloading.clear();
  }

  private joinErrorText(e: string): string {
    const map: Record<string, string> = {
      'password-required': 'This room is password protected. Enter the password to join.',
      'bad-password': 'Incorrect room password.',
      denied: 'The room admin declined your request to join.',
      'approval-timeout': 'The admin did not respond in time.',
      'rate-limited': 'Too many attempts or the room is full. Try again in a minute.',
      'bad-signature': 'Identity verification failed. Reload the page and try again.',
      invalid: 'The server rejected the join request.',
      'connect-failed': 'Could not reach the LANShare server.',
    };
    return map[e] ?? 'Could not join the room.';
  }

  private signalingHandlers(): SignalingHandlers {
    return {
      onStatus: (s) => {
        set({ signaling: s });
        if (s === 'disconnected') this.toast('error', 'Lost connection to the signaling server. Existing peer connections stay up; new people cannot join until it returns.');
      },
      onAwaitingApproval: () => set({ joinStatus: 'awaiting-approval' }),
      onJoinFailed: (e) => {
        this.teardown();
        try {
          sessionStorage.removeItem('lanshare.session');
        } catch {
          /* ignore */
        }
        set({ phase: 'join', joinStatus: 'idle', joinError: this.joinErrorText(e) });
      },
      onJoined: (ack, rejoin) => {
        set({ phase: 'room', joinStatus: 'idle', signaling: 'connected', room: { id: ack.roomId, adminId: ack.adminId, requireApproval: ack.requireApproval, hasPassword: ack.hasPassword } });
        if (rejoin) this.toast('success', 'Reconnected to the signaling server.');
        this.noteAdmin(ack.adminId);
        const peers: Record<string, UiPeer> = {};
        for (const p of ack.peers) peers[p.peerId] = this.uiPeer(p, 'connecting');
        for (const [id, p] of Object.entries(get().peers)) if (!peers[id] && p.conn === 'connected') peers[id] = p;
        set({ peers });
        this.mesh?.reconcile(ack.peers);
        if (rejoin) this.mesh?.retryAll();
        void this.countNeedsReshare();
        void this.refreshStorage();
      },
      onPeerJoined: (p) => {
        set((s) => ({ peers: { ...s.peers, [p.peerId]: s.peers[p.peerId] ?? this.uiPeer(p, 'connecting') } }));
        this.event(`${sanitizeName(p.name)} joined`);
        this.mesh?.addPeer(p);
      },
      onPeerLeft: (id) => {
        const name = get().peers[id]?.name;
        this.mesh?.removePeer(id);
        this.onPeerGone(id);
        set((s) => {
          const { [id]: _gone, ...rest } = s.peers;
          void _gone;
          return { peers: rest };
        });
        if (name) this.event(`${name} left`);
      },
      onPeerRenamed: (id, name) => this.patchPeer(id, { name }),
      onSignal: (from, payload) => this.mesh?.handleSignal(from, payload),
      onJoinRequest: (p) => set((s) => ({ joinRequests: s.joinRequests.some((r) => r.peerId === p.peerId) ? s.joinRequests : [...s.joinRequests, p] })),
      onJoinRequestCancelled: (id) => set((s) => ({ joinRequests: s.joinRequests.filter((r) => r.peerId !== id) })),
      onAdmin: (id) => {
        this.noteAdmin(id);
        set((s) => (s.room ? { room: { ...s.room, adminId: id } } : {}));
      },
      onRoomUpdated: (cfg) => {
        set((s) => (s.room ? { room: { ...s.room, requireApproval: cfg.requireApproval, hasPassword: cfg.hasPassword } } : {}));
      },
      onKicked: () => {
        this.teardown();
        try {
          sessionStorage.removeItem('lanshare.session');
        } catch {
          /* ignore */
        }
        set({ phase: 'join', room: null, peers: {}, joinStatus: 'idle', joinError: 'You were removed from the room by the host.' });
      },
      onReplaced: () => {
        this.teardown();
        set({ phase: 'join', joinStatus: 'idle', joinError: 'LANShare was opened in another tab with this identity. Use "?profile=name" in the URL to run several identities in one browser.' });
      },
    };
  }

  // ============================================================================================
  // Presence / admin / trust
  // ============================================================================================

  private uiPeer(p: PeerInfo, conn: UiPeer['conn']): UiPeer {
    return {
      peerId: p.peerId,
      name: sanitizeName(p.name),
      publicKey: p.publicKey,
      fingerprint: fingerprintOf(p.publicKey),
      conn,
      trusted: this.trusted.has(p.peerId),
      isAdmin: get().room?.adminId === p.peerId,
      sharedFiles: 0,
    };
  }

  private patchPeer(id: string, patch: Partial<UiPeer>) {
    set((s) => (s.peers[id] ? { peers: { ...s.peers, [id]: { ...s.peers[id], ...patch } } } : {}));
  }

  private noteAdmin(id: string) {
    if (!this.records || !id) return;
    const admins = new Set(this.records.knownAdmins());
    if (!admins.has(id)) {
      admins.add(id);
      this.records.setAdmins(admins);
      void this.storage.set('admins:' + this.roomId, [...admins]);
    }
    set((s) => ({ peers: Object.fromEntries(Object.entries(s.peers).map(([k, p]) => [k, { ...p, isAdmin: k === id }])) }));
  }

  decideJoin(peerId: string, allow: boolean) {
    this.signaling?.decide(peerId, allow);
    set((s) => ({ joinRequests: s.joinRequests.filter((r) => r.peerId !== peerId) }));
  }

  updateRoomConfig(cfg: RoomConfigUpdate) {
    if (!this.isAdmin()) return;
    this.signaling?.updateRoomConfig(cfg);
    if (cfg.password !== undefined) {
      try {
        const raw = sessionStorage.getItem('lanshare.session');
        if (raw) {
          const parsed = JSON.parse(raw) as JoinOptions;
          parsed.password = cfg.password || undefined;
          sessionStorage.setItem('lanshare.session', JSON.stringify(parsed));
        }
      } catch {
        /* ignore */
      }
      this.toast('success', cfg.password ? 'Room password updated.' : 'Room password removed.');
    }
  }

  kickPeer(peerId: string) {
    if (!this.isAdmin() || peerId === this.identity?.peerId) return;
    const peerName = get().peers[peerId]?.name ?? 'User';
    this.signaling?.kick(peerId);
    this.toast('info', `Removed ${peerName} from the room.`);
  }

  setTrusted(peerId: string, trusted: boolean) {
    if (trusted) this.trusted.add(peerId);
    else this.trusted.delete(peerId);
    void this.storage.set('trusted', [...this.trusted]);
    this.patchPeer(peerId, { trusted });
  }

  async setName(name: string) {
    const clean = sanitizeName(name, get().name);
    set({ name: clean });
    await this.storage.set('name', clean);
    this.signaling?.rename(clean);
    this.mesh?.broadcast({ t: 'profile', name: clean });
  }

  isAdmin(): boolean {
    return get().room?.adminId === this.identity?.peerId;
  }

  // ============================================================================================
  // Peer lifecycle
  // ============================================================================================

  private onPeerReady(s: PeerSession) {
    this.patchPeer(s.peerId, { conn: 'connected', name: s.name });
    s.send({ t: 'files-have', full: true, add: this.registry.heldIds().slice(0, 5000), remove: [] });
    if (this.records) s.send({ t: 'sync-have', ids: this.records.allIds(LIMITS.syncIdsMax) });
    this.scheduleAvail();
  }

  private onPeerGone(peerId: string) {
    this.peerFiles.delete(peerId);
    this.transfers?.handlePeerGone(peerId);
    this.scheduleAvail();
  }

  // ============================================================================================
  // Incoming control messages
  // ============================================================================================

  private rate(peerId: string, key: string, limit: number, windowMs: number): boolean {
    const k = `${peerId}:${key}`;
    const now = Date.now();
    const arr = (this.rates.get(k) ?? []).filter((t) => now - t < windowMs);
    arr.push(now);
    this.rates.set(k, arr);
    return arr.length <= limit;
  }

  private async onMessage(s: PeerSession, msg: PeerMsg) {
    const peerId = s.peerId;
    const records = this.records;
    if (!records) return;
    try {
      switch (msg.t) {
        case 'record': {
          if (!this.rate(peerId, 'record', 120, 10_000)) return;
          const rec = validateRecord(msg.rec);
          if (!rec || rec.authorId !== peerId) return; // live records must come from their author
          await this.ingest([rec]);
          s.send({ t: 'ack', ids: [rec.id] });
          return;
        }
        case 'ack': {
          if (!Array.isArray(msg.ids)) return;
          const ids = msg.ids.slice(0, 200).filter((i) => isId(i));
          set((st) => {
            const acks = { ...st.acks };
            for (const id of ids) if (acks[id] && !acks[id].includes(peerId)) acks[id] = [...acks[id], peerId];
            return { acks };
          });
          return;
        }
        case 'sync-have': {
          if (!this.rate(peerId, 'sync-have', 6, 30_000) || !Array.isArray(msg.ids)) return;
          const theirs = new Set(msg.ids.slice(0, LIMITS.syncIdsMax).filter((i): i is string => typeof i === 'string' && i.length <= 44));
          const missing = records.missingFor(theirs).slice(-SYNC_CAP);
          for (const batch of batchRecords(missing, LIMITS.syncBatchMax)) s.send({ t: 'sync-records', recs: batch });
          return;
        }
        case 'sync-records': {
          if (!this.rate(peerId, 'sync-records', 80, 10_000) || !Array.isArray(msg.recs)) return;
          const valid: RoomRecord[] = [];
          for (const r of msg.recs.slice(0, LIMITS.syncBatchMax)) {
            const v = validateRecord(r);
            if (v) valid.push(v);
          }
          await this.ingest(valid);
          return;
        }
        case 'files-have': {
          if (!this.rate(peerId, 'files-have', 60, 10_000)) return;
          const set_ = this.peerFiles.get(peerId) ?? new Set<string>();
          if (msg.full) set_.clear();
          for (const f of Array.isArray(msg.add) ? msg.add.slice(0, 5000) : []) if (isId(f) && set_.size < 20_000) set_.add(f);
          for (const f of Array.isArray(msg.remove) ? msg.remove.slice(0, 5000) : []) if (typeof f === 'string') set_.delete(f);
          this.peerFiles.set(peerId, set_);
          this.scheduleAvail();
          return;
        }
        case 'profile':
          this.patchPeer(peerId, { name: s.name });
          return;
        default:
          this.transfers?.handleControl(peerId, msg);
      }
    } catch (e) {
      console.warn('message handling failed', msg.t, e);
    }
  }

  private async ingest(recs: RoomRecord[]) {
    const records = this.records;
    if (!records) return;
    for (const rec of recs) {
      const res = await records.add(rec);
      if (res === 'added' && rec.kind === 'delete' && rec.target) this.afterDeletion(rec.target);
    }
    this.scheduleAvail();
  }

  /** A tombstone was applied: stop serving the removed record's files from this device. */
  private afterDeletion(targetId: string) {
    const r = this.records;
    if (!r || r.get(targetId)) return; // not actually removed (unauthorised or target unknown)
    // The record content is gone; we cannot read its files any more, so reconcile against the registry.
    const live = new Set(r.fileEntries().map((e) => e.meta.fileId));
    for (const id of this.registry.heldIds()) if (!live.has(id)) void this.stopSharing(id, true);
  }

  // ============================================================================================
  // Records: send / delete / history
  // ============================================================================================

  private nextTs(): number {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    return this.lastTs;
  }

  private makeRecord(part: Pick<UnsignedRecord, 'kind'> & Partial<UnsignedRecord>): RoomRecord {
    const rec: UnsignedRecord = {
      id: randomId(),
      roomId: this.roomId,
      authorId: this.identity.peerId,
      authorKey: this.identity.publicKey,
      authorName: get().name,
      ts: this.nextTs(),
      ...part,
    };
    return signRecord(rec, this.identity.secretKey);
  }

  private async commit(rec: RoomRecord) {
    if (!this.records) return;
    await this.records.add(rec);
    set((s) => ({ acks: { ...s.acks, [rec.id]: [] } }));
    this.mesh?.broadcast({ t: 'record', rec });
  }

  async sendText(text: string): Promise<boolean> {
    const clean = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    if (!clean || !this.records) return false;
    if (clean.length > LIMITS.textMax) {
      this.toast('error', `Messages are limited to ${LIMITS.textMax} characters.`);
      return false;
    }
    await this.commit(this.makeRecord({ kind: 'text', text: clean }));
    return true;
  }

  async postFiles(items: PickedFile[], caption: string): Promise<void> {
    if (!this.records || !items.length) return;
    const { settings } = get();
    const max = settings.maxFileSizeMB > 0 ? settings.maxFileSizeMB * MB : LIMITS.fileSizeHardMax;
    const picked = items.slice(0, LIMITS.filesPerPost);
    if (items.length > picked.length) this.toast('error', `Only ${LIMITS.filesPerPost} files can be posted at once.`);
    const metas: FileMeta[] = [];
    const handles: Array<{ fileId: string; handle: FileSystemFileHandle; name: string; size: number }> = [];
    for (const { file, handle } of picked) {
      if (file.size > max) {
        this.toast('error', `"${file.name}" is larger than your limit (${settings.maxFileSizeMB} MB).`);
        continue;
      }
      const hid = randomId();
      set((s) => ({ hashing: { ...s.hashing, [hid]: { name: file.name, pct: 0 } } }));
      try {
        const sha256 = await hashFile(file, (p) => set((s) => (s.hashing[hid] ? { hashing: { ...s.hashing, [hid]: { name: file.name, pct: Math.round(p * 100) } } } : {})));
        const thumb = settings.showThumbnails ? await makeThumbnail(file) : undefined;
        const meta: FileMeta = {
          fileId: randomId(),
          name: sanitizeFileName(file.name),
          mime: guessMime(file.name, file.type),
          size: file.size,
          sha256,
          uploaderId: this.identity.peerId,
          ...(thumb ? { thumb } : {}),
        };
        this.registry.addSession(meta.fileId, file);
        if (handle) handles.push({ fileId: meta.fileId, handle, name: file.name, size: file.size });
        metas.push(meta);
      } catch (e) {
        this.toast('error', `Could not read "${file.name}": ${e instanceof Error ? e.message : 'unknown error'}`);
      } finally {
        set((s) => {
          const { [hid]: _h, ...rest } = s.hashing;
          void _h;
          return { hashing: rest };
        });
      }
    }
    if (!metas.length) return;
    for (const h of handles) void this.storage.putHandle({ ...h, roomId: this.roomId }).catch(() => undefined);
    const text = caption.replace(/\r\n?/g, '\n').trim().slice(0, LIMITS.textMax);
    await this.commit(this.makeRecord({ kind: 'file', files: metas, ...(text ? { text } : {}) }));
    this.announce(metas.map((m) => m.fileId), []);
    this.scheduleAvail();
  }

  /** scope 'me': hide locally (not propagated). scope 'everyone': signed tombstone (author or admin only). */
  async deleteRecord(id: string, scope: 'me' | 'everyone') {
    const records = this.records;
    const rec = records?.get(id);
    if (!records || !rec) return;
    if (scope === 'me') {
      this.hidden.add(id);
      await this.storage.set('hidden:' + this.roomId, [...this.hidden]);
      set({ hiddenIds: [...this.hidden] });
      this.syncRecordsToStore();
      return;
    }
    if (rec.authorId !== this.identity.peerId && !this.isAdmin()) return this.toast('error', 'Only the author or the room admin can delete for everyone.');
    await this.commit(this.makeRecord({ kind: 'delete', target: id }));
    this.afterDeletion(id);
    this.toast('info', 'Deleted for everyone.');
  }

  async clearLocalHistory() {
    if (!this.records) return;
    const ts = Date.now();
    await this.records.clearHistory(ts);
    await this.storage.set('cleared:' + this.roomId, ts);
    set({ acks: {}, events: [] });
    this.toast('info', 'Local history cleared. Messages older than now will not be re-imported from peers.');
  }

  private syncRecordsToStore() {
    const records = this.records;
    if (!records) return;
    const visible = records.visible.filter((r) => !this.hidden.has(r.id));
    const counts: Record<string, number> = {};
    for (const r of visible) if (r.kind === 'file') counts[r.authorId] = (counts[r.authorId] ?? 0) + (r.files?.length ?? 0);
    set((s) => ({
      records: visible,
      peers: Object.fromEntries(Object.entries(s.peers).map(([k, p]) => [k, { ...p, sharedFiles: counts[k] ?? 0 }])),
    }));
    this.scheduleAvail();
  }

  // ============================================================================================
  // Availability
  // ============================================================================================

  private holders(fileId: string): string[] {
    const meta = this.records?.fileMeta(fileId);
    const out: string[] = [];
    for (const [peerId, files] of this.peerFiles) if (files.has(fileId) && this.mesh?.session(peerId)?.ready) out.push(peerId);
    return out.sort((a, b) => Number(b === meta?.uploaderId) - Number(a === meta?.uploaderId));
  }

  private scheduleAvail() {
    if (this.availQueued) return;
    this.availQueued = true;
    queueMicrotask(() => {
      this.availQueued = false;
      this.computeAvail();
    });
  }

  private computeAvail() {
    if (!this.records) return;
    const avail: Record<string, FileAvailability> = {};
    for (const { meta } of this.records.fileEntries()) {
      const kind = this.registry.kind(meta.fileId);
      avail[meta.fileId] = { local: kind !== null, localKind: kind ?? undefined, peers: this.holders(meta.fileId) };
    }
    set({ avail });
  }

  private announce(add: string[], remove: string[]) {
    if (add.length || remove.length) this.mesh?.broadcast({ t: 'files-have', full: false, add, remove });
  }

  // ============================================================================================
  // Downloading / sharing
  // ============================================================================================

  private transferHost(): TransferHost {
    return {
      sendCtl: (peerId, msg) => this.mesh?.send(peerId, msg) ?? false,
      openChannel: (peerId, id) => this.mesh?.session(peerId)?.openTransferChannel(id) ?? null,
      getMeta: (id) => this.records?.fileMeta(id),
      getSource: (id) => this.registry.getSource(id),
      holders: (id) => this.holders(id),
      settings: () => {
        const s = get().settings;
        return {
          maxUploads: s.maxUploads,
          maxDownloads: s.maxDownloads,
          chunkSize: s.chunkSize,
          windowBytes: s.windowMB * MB,
          maxFileSize: s.maxFileSizeMB > 0 ? s.maxFileSizeMB * MB : LIMITS.fileSizeHardMax,
        };
      },
      onChange: (v) => this.onTransfer(v),
    };
  }

  private onTransfer(v: TransferView) {
    set((s) => {
      const transfers = { ...s.transfers, [v.id]: v };
      const finished = Object.values(transfers).filter((t) => t.state === 'done' || t.state === 'failed' || t.state === 'cancelled').sort((a, b) => a.startedAt - b.startedAt);
      for (const t of finished.slice(0, Math.max(0, finished.length - 25))) delete transfers[t.id];
      return { transfers };
    });
  }

  clearFinishedTransfers() {
    set((s) => ({ transfers: Object.fromEntries(Object.entries(s.transfers).filter(([, t]) => !['done', 'failed', 'cancelled'].includes(t.state))) }));
  }

  cancelTransfer(id: string) {
    this.transfers?.cancel(id);
  }

  async download(fileId: string, keep: boolean): Promise<void> {
    const records = this.records;
    const meta = records?.fileMeta(fileId);
    if (!records || !meta || !this.transfers) return;
    if (this.downloading.has(fileId)) return;
    if (this.registry.has(fileId)) return this.saveLocal(fileId);
    if (this.holders(fileId).length === 0) return this.toast('error', 'File currently unavailable — no online peer has a copy.');
    const { settings } = get();
    if (settings.maxFileSizeMB > 0 && meta.size > settings.maxFileSizeMB * MB) return this.toast('error', `This file is larger than your limit of ${settings.maxFileSizeMB} MB (change it in Settings).`);

    let wantKeep = keep && settings.replicationEnabled;
    if (wantKeep) {
      const used = (await this.storage.listReplicas()).filter((r) => !r.temp).reduce((n, r) => n + r.size, 0);
      if (used + meta.size > settings.storageLimitMB * MB) {
        this.toast('error', 'Your cache limit would be exceeded, so this file will not be kept for sharing. Raise the limit in Settings to keep it.');
        wantKeep = false;
      } else void requestPersistence();
    }
    let sink: Sink;
    let mode: 'keep' | 'temp' | 'disk';
    if (wantKeep) {
      sink = new StoreSink(this.storage, fileId);
      mode = 'keep';
    } else if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
        sink = new DiskSink(handle);
        mode = 'disk';
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        this.toast('error', 'Could not open the save dialog; downloading via browser storage instead.');
        sink = new StoreSink(this.storage, fileId);
        mode = 'temp';
      }
    } else {
      sink = new StoreSink(this.storage, fileId);
      mode = 'temp';
    }

    this.downloading.add(fileId);
    const { done } = this.transfers.download({ fileId, sink, keep: wantKeep });
    const res = await done;
    this.downloading.delete(fileId);
    if (!res.ok) {
      if (!res.cancelled) this.toast('error', `Download failed: ${res.error ?? 'unknown error'}`);
      return;
    }
    if (mode === 'disk') return this.toast('success', `Saved "${meta.name}" (verified SHA-256).`);

    const rep: ReplicaRecord = {
      fileId,
      roomId: this.roomId,
      sha256: meta.sha256,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      segments: (sink as StoreSink).segments,
      complete: true,
      temp: mode === 'temp',
      storedAt: Date.now(),
    };
    await this.storage.putReplica(rep);
    if (mode === 'keep') {
      this.registry.addReplica(rep);
      this.announce([fileId], []);
    } else {
      setTimeout(() => void this.storage.removeReplica(fileId).catch(() => undefined), 15 * 60_000);
    }
    const blob = await this.storage.replicaBlob(fileId);
    if (blob) saveBlob(blob, meta.name);
    this.toast('success', mode === 'keep' ? `Saved "${meta.name}" and now sharing it with others.` : `Saved "${meta.name}" (verified SHA-256).`);
    void this.refreshStorage();
  }

  /** Save a file this device already holds (own upload or replica) to disk. */
  async saveLocal(fileId: string) {
    const meta = this.records?.fileMeta(fileId);
    const blob = await this.registry.getSource(fileId);
    if (!meta || !blob) return this.toast('error', 'The local copy is no longer available.');
    saveBlob(blob, meta.name);
  }

  async stopSharing(fileId: string, quiet = false) {
    await this.registry.stop(fileId);
    await this.storage.removeHandle(fileId).catch(() => undefined);
    this.announce([], [fileId]);
    void this.refreshStorage();
    if (!quiet) this.toast('info', 'Stopped sharing this file from your device. Your original file was not touched.');
  }

  async clearCache() {
    for (const r of await this.storage.listReplicas()) await this.stopSharing(r.fileId, true);
    await this.refreshStorage();
    this.toast('info', 'Cached copies removed.');
  }

  /** Re-authorise files picked earlier via the File System Access API (needs a click). */
  async restoreHandles() {
    const added: string[] = [];
    for (const h of await this.storage.listHandles()) {
      if (h.roomId !== this.roomId || this.registry.has(h.fileId)) continue;
      const meta = this.records?.fileMeta(h.fileId);
      if (!meta) continue;
      try {
        if ((await h.handle.requestPermission?.({ mode: 'read' })) !== 'granted') continue;
        const file = await h.handle.getFile();
        if (file.size !== meta.size) {
          this.toast('error', `"${meta.name}" changed on disk and cannot be shared.`);
          continue;
        }
        this.registry.addSession(h.fileId, file);
        added.push(h.fileId);
      } catch {
        /* permission denied or file moved */
      }
    }
    this.announce(added, []);
    if (added.length) this.toast('success', `Sharing ${added.length} file${added.length > 1 ? 's' : ''} again.`);
    void this.countNeedsReshare();
  }

  private async countNeedsReshare() {
    const hs = await this.storage.listHandles();
    const n = hs.filter((h) => h.roomId === this.roomId && !this.registry.has(h.fileId) && this.records?.fileMeta(h.fileId)).length;
    set({ needsReshare: n });
  }

  // ============================================================================================
  // Settings / storage / misc
  // ============================================================================================

  async updateSettings(patch: Partial<Settings>) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await this.storage.set('settings', settings);
  }

  async refreshStorage() {
    const est = await storageEstimate();
    const replicas = (await this.storage.listReplicas()).filter((r) => r.complete && !r.temp);
    set({ storage: { ...est, replicas } });
  }

  async requestPersistent() {
    const ok = await requestPersistence();
    this.toast(ok ? 'success' : 'info', ok ? 'Browser storage marked persistent.' : 'The browser did not grant persistent storage (it may still keep data).');
    void this.refreshStorage();
  }

  /** Wipe this browser's LANShare data (identity, history, cached files). */
  async resetEverything() {
    this.leave();
    await this.storage.clearAll();
    location.reload();
  }

  event(text: string) {
    set((s) => ({ events: [...s.events.slice(-199), { id: randomId(), ts: Date.now(), text }] }));
  }

  toast(kind: Toast['kind'], text: string) {
    const id = randomId();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 8000 : 4500);
  }

  dismissToast(id: string) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }
}

export const engine = new Engine();
export { useApp };

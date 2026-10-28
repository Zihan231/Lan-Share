/** Metadata of a file shared in the room. The bytes themselves never leave the owners' devices. */
export interface FileMeta {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  /** Lower-case hex SHA-256 of the whole file. */
  sha256: string;
  uploaderId: string;
  /** Optional small JPEG data URL preview (images only). */
  thumb?: string;
}

export type RecordKind = 'text' | 'file' | 'delete';

/**
 * A signed, immutable room record. Everything that is synchronised between peers
 * (chat text, file posts, deletion tombstones) is a Record, so any peer can relay history
 * for any author without being able to forge or alter it.
 */
export interface RoomRecord {
  id: string;
  roomId: string;
  kind: RecordKind;
  authorId: string;
  /** Author's Ed25519 public key (base64url). authorId must equal hash(authorKey). */
  authorKey: string;
  authorName: string;
  ts: number;
  text?: string;
  files?: FileMeta[];
  /** For kind === 'delete': the record id being deleted. */
  target?: string;
  sig: string;
}

export type UnsignedRecord = Omit<RoomRecord, 'sig'>;

// ----------------------------------------------------------------------------------------------
// Signaling protocol (client <-> local signaling server)
// ----------------------------------------------------------------------------------------------

export interface PeerInfo {
  peerId: string;
  name: string;
  publicKey: string;
}

export type JoinError =
  | 'invalid'
  | 'bad-signature'
  | 'password-required'
  | 'bad-password'
  | 'denied'
  | 'approval-timeout'
  | 'rate-limited';

export interface JoinRequest {
  roomId: string;
  peerId: string;
  publicKey: string;
  name: string;
  /** Signature over `joinMessage(roomId, nonce)` proving possession of the private key. */
  sig: string;
  password?: string;
  /** Only honoured when this join creates the room. */
  requireApproval?: boolean;
  protocol: number;
}

export type JoinAck =
  | { ok: true; roomId: string; adminId: string; requireApproval: boolean; hasPassword: boolean; peers: PeerInfo[] }
  | { ok: false; error: JoinError };

export type SignalPayload =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

export interface RoomConfigUpdate {
  password?: string | null;
  requireApproval?: boolean;
}

export interface ServerToClientEvents {
  challenge: (nonce: string) => void;
  'peer-joined': (peer: PeerInfo) => void;
  'peer-left': (peerId: string) => void;
  'peer-renamed': (peerId: string, name: string) => void;
  signal: (from: string, payload: SignalPayload) => void;
  'join-request': (peer: PeerInfo) => void;
  'join-request-cancelled': (peerId: string) => void;
  admin: (peerId: string) => void;
  'room-updated': (cfg: { requireApproval: boolean; hasPassword: boolean }) => void;
  kicked: () => void;
  replaced: () => void;
}

export interface ClientToServerEvents {
  join: (req: JoinRequest, ack: (res: JoinAck) => void) => void;
  signal: (to: string, payload: SignalPayload) => void;
  decide: (peerId: string, allow: boolean) => void;
  'room-config': (cfg: RoomConfigUpdate) => void;
  kick: (peerId: string) => void;
  rename: (name: string) => void;
  leave: () => void;
}

export function joinMessage(roomId: string, nonce: string): string {
  return `lanshare-join|v1|${roomId}|${nonce}`;
}

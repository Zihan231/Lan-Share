import type { FileMeta, PeerInfo, RoomRecord } from '@lanshare/shared';

export type { FileMeta, PeerInfo, RoomRecord };

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  /** Bytes per DataChannel message for outgoing file chunks. */
  chunkSize: number;
  maxUploads: number;
  maxDownloads: number;
  /** Largest file (MB) this device will post or accept. 0 = protocol maximum. */
  maxFileSizeMB: number;
  /** Allow keeping verified copies of downloaded files so this device can serve them to others. */
  replicationEnabled: boolean;
  /** Max total size (MB) of replicated copies stored in the browser. */
  storageLimitMB: number;
  showThumbnails: boolean;
  /** Receiver flow-control window in MB (data in flight not yet persisted). */
  windowMB: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  chunkSize: 64 * 1024,
  maxUploads: 3,
  maxDownloads: 3,
  maxFileSizeMB: 10_240,
  replicationEnabled: true,
  storageLimitMB: 4096,
  showThumbnails: true,
  windowMB: 16,
};

export type TransferState = 'queued' | 'requesting' | 'receiving' | 'sending' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface TransferView {
  id: string;
  fileId: string;
  direction: 'down' | 'up';
  peerId: string;
  name: string;
  size: number;
  bytes: number;
  /** bytes per second (moving average) */
  speed: number;
  /** seconds, or null if unknown */
  eta: number | null;
  state: TransferState;
  error?: string;
  startedAt: number;
  keep: boolean;
}

export type PeerConn = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'offline';

export interface UiPeer {
  peerId: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  conn: PeerConn;
  trusted: boolean;
  isAdmin: boolean;
  sharedFiles: number;
}

export interface SystemEvent {
  id: string;
  ts: number;
  text: string;
}

export interface FileAvailability {
  /** This device can serve the file right now. */
  local: boolean;
  /** Source of the local copy. */
  localKind?: 'session' | 'replica';
  /** Connected peers that announced a complete copy. */
  peers: string[];
}

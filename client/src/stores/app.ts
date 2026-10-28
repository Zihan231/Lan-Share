import { create } from 'zustand';
import type { PeerInfo, RoomRecord } from '@lanshare/shared';
import { DEFAULT_SETTINGS, type FileAvailability, type Settings, type SystemEvent, type TransferView, type UiPeer } from '../types';
import type { ReplicaRecord } from '../services/storage/db';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface RoomInfo {
  id: string;
  adminId: string;
  requireApproval: boolean;
  hasPassword: boolean;
}

export type Panel = 'files' | 'people' | 'settings' | 'transfers' | null;

export interface AppState {
  phase: 'boot' | 'join' | 'joining' | 'room';
  bootError: string | null;
  identity: { peerId: string; publicKey: string; fingerprint: string } | null;
  name: string;
  joinError: string | null;
  joinStatus: 'idle' | 'connecting' | 'awaiting-approval';
  room: RoomInfo | null;
  signaling: 'connecting' | 'connected' | 'disconnected';
  peers: Record<string, UiPeer>;
  records: RoomRecord[];
  events: SystemEvent[];
  acks: Record<string, string[]>;
  avail: Record<string, FileAvailability>;
  transfers: Record<string, TransferView>;
  hashing: Record<string, { name: string; pct: number }>;
  joinRequests: PeerInfo[];
  settings: Settings;
  toasts: Toast[];
  storage: { usage: number; quota: number; persisted: boolean; replicas: ReplicaRecord[] };
  lanUrls: string[];
  isHostDevice: boolean;
  secureContext: boolean;
  canSaveToDisk: boolean;
  /** persisted file handles that need the user's permission after a refresh */
  needsReshare: number;
  hiddenIds: string[];
  panel: Panel;
  loaded: boolean;
}

export const useApp = create<AppState>(() => ({
  phase: 'boot',
  bootError: null,
  identity: null,
  name: '',
  joinError: null,
  joinStatus: 'idle',
  room: null,
  signaling: 'connecting',
  peers: {},
  records: [],
  events: [],
  acks: {},
  avail: {},
  transfers: {},
  hashing: {},
  joinRequests: [],
  settings: DEFAULT_SETTINGS,
  toasts: [],
  storage: { usage: 0, quota: 0, persisted: false, replicas: [] },
  lanUrls: [],
  isHostDevice: typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1'),
  secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
  canSaveToDisk: typeof window !== 'undefined' && 'showSaveFilePicker' in window,
  needsReshare: 0,
  hiddenIds: [],
  panel: null,
  loaded: false,
}));

export const set = useApp.setState;
export const get = useApp.getState;

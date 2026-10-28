import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RoomRecord } from '@lanshare/shared';
import type { RecordPersistence } from '../sync/RecordStore';

export interface ReplicaRecord {
  fileId: string;
  roomId: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  segments: number;
  complete: boolean;
  /** Temporary copies exist only to hand the file to the browser's download manager. */
  temp: boolean;
  storedAt: number;
}

export interface HandleRecord {
  fileId: string;
  roomId: string;
  handle: FileSystemFileHandle;
  name: string;
  size: number;
}

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  records: { key: string; value: RoomRecord; indexes: { room: string } };
  replicas: { key: string; value: ReplicaRecord };
  segments: { key: [string, number]; value: Blob };
  handles: { key: string; value: HandleRecord };
}

export const SEGMENT_SIZE = 4 * 1024 * 1024;

export class Storage implements RecordPersistence {
  private constructor(private db: IDBPDatabase<Schema>) {}

  static async open(profile = ''): Promise<Storage> {
    const name = 'lanshare' + (profile ? '-' + profile : '');
    const db = await openDB<Schema>(name, 1, {
      upgrade(d) {
        d.createObjectStore('kv');
        d.createObjectStore('records', { keyPath: 'id' }).createIndex('room', 'roomId');
        d.createObjectStore('replicas', { keyPath: 'fileId' });
        d.createObjectStore('segments');
        d.createObjectStore('handles', { keyPath: 'fileId' });
      },
    });
    return new Storage(db);
  }

  // ---- key/value ----
  async get<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('kv', key)) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.db.put('kv', value, key);
  }
  async del(key: string): Promise<void> {
    await this.db.delete('kv', key);
  }

  // ---- records (RecordPersistence) ----
  loadRoom(roomId: string): Promise<RoomRecord[]> {
    return this.db.getAllFromIndex('records', 'room', roomId);
  }
  async put(rec: RoomRecord): Promise<void> {
    await this.db.put('records', rec);
  }
  async delete(id: string): Promise<void> {
    await this.db.delete('records', id);
  }
  async deleteRoom(roomId: string): Promise<void> {
    const tx = this.db.transaction('records', 'readwrite');
    const keys = await tx.store.index('room').getAllKeys(roomId);
    await Promise.all(keys.map((k) => tx.store.delete(k)));
    await tx.done;
  }

  // ---- replicas (verified copies kept to serve other peers) ----
  async putSegment(fileId: string, index: number, blob: Blob): Promise<void> {
    await this.db.put('segments', blob, [fileId, index]);
  }
  async deleteSegments(fileId: string): Promise<void> {
    await this.db.delete('segments', IDBKeyRange.bound([fileId, 0], [fileId, Number.MAX_SAFE_INTEGER]));
  }
  async getReplica(fileId: string): Promise<ReplicaRecord | undefined> {
    return this.db.get('replicas', fileId);
  }
  async putReplica(rec: ReplicaRecord): Promise<void> {
    await this.db.put('replicas', rec);
  }
  async listReplicas(): Promise<ReplicaRecord[]> {
    return this.db.getAll('replicas');
  }
  async removeReplica(fileId: string): Promise<void> {
    await this.deleteSegments(fileId);
    await this.db.delete('replicas', fileId);
  }
  /** A Blob concatenating the stored segments (file-backed in the browser; not loaded into RAM). */
  async replicaBlob(fileId: string): Promise<Blob | null> {
    const rep = await this.getReplica(fileId);
    if (!rep?.complete) return null;
    const parts = await this.db.getAll('segments', IDBKeyRange.bound([fileId, 0], [fileId, Number.MAX_SAFE_INTEGER]));
    if (parts.length !== rep.segments) return null;
    const blob = new Blob(parts, { type: rep.mime || 'application/octet-stream' });
    return blob.size === rep.size ? blob : null;
  }

  // ---- file handles (File System Access API; Chromium, secure contexts) ----
  async putHandle(rec: HandleRecord): Promise<void> {
    await this.db.put('handles', rec);
  }
  async listHandles(): Promise<HandleRecord[]> {
    return this.db.getAll('handles');
  }
  async removeHandle(fileId: string): Promise<void> {
    await this.db.delete('handles', fileId);
  }

  async clearAll(): Promise<void> {
    for (const s of ['kv', 'records', 'replicas', 'segments', 'handles'] as const) await this.db.clear(s);
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0, persisted };
  } catch {
    return { usage: 0, quota: 0, persisted: false };
  }
}

export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

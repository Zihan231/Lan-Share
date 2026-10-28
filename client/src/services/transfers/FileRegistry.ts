import type { ReplicaRecord, Storage } from '../storage/db';

export type HoldKind = 'session' | 'replica';

/**
 * Tracks which files THIS device can serve to others.
 *  - session: the original File object chosen by the user, valid until the page is closed/refreshed
 *             (or re-authorised through a persisted File System Access handle).
 *  - replica: a complete, hash-verified copy in IndexedDB that the user opted to keep sharing.
 */
export class FileRegistry {
  private session = new Map<string, Blob>();
  private replicas = new Map<string, ReplicaRecord>();
  private listeners = new Set<() => void>();

  constructor(private readonly storage: Pick<Storage, 'replicaBlob' | 'listReplicas' | 'removeReplica'>) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  async loadReplicas(): Promise<ReplicaRecord[]> {
    const all = await this.storage.listReplicas();
    this.replicas.clear();
    for (const r of all) if (r.complete && !r.temp) this.replicas.set(r.fileId, r);
    this.emit();
    return all;
  }

  addSession(fileId: string, blob: Blob) {
    this.session.set(fileId, blob);
    this.emit();
  }
  addReplica(rec: ReplicaRecord) {
    if (rec.complete && !rec.temp) this.replicas.set(rec.fileId, rec);
    this.emit();
  }

  kind(fileId: string): HoldKind | null {
    return this.session.has(fileId) ? 'session' : this.replicas.has(fileId) ? 'replica' : null;
  }
  has(fileId: string): boolean {
    return this.kind(fileId) !== null;
  }
  heldIds(): string[] {
    return [...new Set([...this.session.keys(), ...this.replicas.keys()])];
  }
  replicaIds(): string[] {
    return [...this.replicas.keys()];
  }

  async getSource(fileId: string): Promise<Blob | null> {
    const s = this.session.get(fileId);
    if (s) return s;
    if (this.replicas.has(fileId)) return this.storage.replicaBlob(fileId);
    return null;
  }

  /** Stop serving a file from this device. Never touches the user's original file on disk. */
  async stop(fileId: string): Promise<void> {
    this.session.delete(fileId);
    if (this.replicas.delete(fileId)) await this.storage.removeReplica(fileId);
    this.emit();
  }
}

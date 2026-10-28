import { compareRecords, isDeleteAuthorised, type FileMeta, type RoomRecord } from '@lanshare/shared';

export interface RecordPersistence {
  loadRoom(roomId: string): Promise<RoomRecord[]>;
  put(rec: RoomRecord): Promise<void>;
  delete(id: string): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
}

export class MemoryPersistence implements RecordPersistence {
  readonly data = new Map<string, RoomRecord>();
  async loadRoom(roomId: string) {
    return [...this.data.values()].filter((r) => r.roomId === roomId);
  }
  async put(rec: RoomRecord) {
    this.data.set(rec.id, rec);
  }
  async delete(id: string) {
    this.data.delete(id);
  }
  async deleteRoom(roomId: string) {
    for (const [k, v] of this.data) if (v.roomId === roomId) this.data.delete(k);
  }
}

export type AddResult = 'added' | 'duplicate' | 'tombstoned' | 'cleared' | 'wrong-room' | 'unauthorised-delete';

export interface RecordStoreOptions {
  clearedBefore?: number;
  adminIds?: Iterable<string>;
}

/**
 * The room's synchronised log.
 *
 *  - Identity of a record is its random ID, so receiving the same record twice (reconnect, two peers
 *    relaying history, ...) is a no-op.
 *  - Deletions are signed tombstones. A tombstone is kept forever, so an older peer that still holds the
 *    original record cannot resurrect it. A tombstone is honoured only if signed by the record's author or
 *    by a known admin; if the target has not arrived yet the tombstone waits and is evaluated on arrival.
 *  - Visible order is (timestamp, id), identical on every peer once they hold the same records.
 *
 * Only signature-validated records must be passed to {@link add} (validation lives in the protocol layer).
 */
export class RecordStore {
  private byId = new Map<string, RoomRecord>();
  /** target id -> tombstone records pointing at it */
  private tombs = new Map<string, RoomRecord[]>();
  /** ids whose content was dropped because a valid tombstone applied */
  private deleted = new Set<string>();
  private order: RoomRecord[] = []; // visible, non-delete, sorted
  private admins: Set<string>;
  private listeners = new Set<() => void>();
  clearedBefore: number;

  constructor(
    readonly roomId: string,
    private readonly db: RecordPersistence,
    opts: RecordStoreOptions = {},
  ) {
    this.clearedBefore = opts.clearedBefore ?? 0;
    this.admins = new Set(opts.adminIds ?? []);
  }

  async load(): Promise<void> {
    const all = await this.db.loadRoom(this.roomId);
    this.byId.clear();
    this.tombs.clear();
    this.deleted.clear();
    for (const r of all) {
      this.byId.set(r.id, r);
      if (r.kind === 'delete' && r.target) this.indexTomb(r);
    }
    await this.recompute();
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  get visible(): readonly RoomRecord[] {
    return this.order;
  }
  has(id: string): boolean {
    return this.byId.has(id) || this.deleted.has(id);
  }
  get(id: string): RoomRecord | undefined {
    return this.byId.get(id);
  }

  setAdmins(ids: Iterable<string>) {
    this.admins = new Set(ids);
    void this.recompute().then(() => this.emit());
  }
  knownAdmins(): ReadonlySet<string> {
    return this.admins;
  }

  private indexTomb(t: RoomRecord) {
    const list = this.tombs.get(t.target!) ?? [];
    if (!list.some((x) => x.id === t.id)) list.push(t);
    this.tombs.set(t.target!, list);
  }

  private isTombstoned(target: RoomRecord | undefined, targetId: string): boolean {
    const list = this.tombs.get(targetId);
    if (!list) return false;
    return list.some((t) => isDeleteAuthorised(t, target?.authorId, this.admins));
  }

  /** Recompute which records are visible; physically drop deleted content (tombstones stay). */
  private async recompute(): Promise<void> {
    const drop: string[] = [];
    for (const [id, rec] of this.byId) {
      if (rec.kind === 'delete') continue;
      if (this.isTombstoned(rec, id)) drop.push(id);
    }
    for (const id of drop) {
      this.byId.delete(id);
      this.deleted.add(id);
      await this.db.delete(id);
    }
    this.order = [...this.byId.values()].filter((r) => r.kind !== 'delete' && r.ts > this.clearedBefore).sort(compareRecords);
  }

  async add(rec: RoomRecord): Promise<AddResult> {
    if (rec.roomId !== this.roomId) return 'wrong-room';
    if (this.byId.has(rec.id) || this.deleted.has(rec.id)) return 'duplicate';
    if (rec.ts <= this.clearedBefore) return 'cleared';

    if (rec.kind === 'delete') {
      // Stored even if not yet applicable: the target may arrive later, or the signer may be learned to be an admin.
      this.byId.set(rec.id, rec);
      this.indexTomb(rec);
      await this.db.put(rec);
      await this.recompute();
      this.emit();
      return 'added';
    }

    if (this.isTombstoned(rec, rec.id)) {
      // Remember the id so peers do not keep re-sending it; content is never stored.
      this.deleted.add(rec.id);
      return 'tombstoned';
    }
    this.byId.set(rec.id, rec);
    await this.db.put(rec);
    this.insertSorted(rec);
    this.emit();
    return 'added';
  }

  private insertSorted(rec: RoomRecord) {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareRecords(this.order[mid], rec) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.order = [...this.order.slice(0, lo), rec, ...this.order.slice(lo)];
  }

  /** IDs advertised during sync: everything we hold or know to be deleted (so peers do not re-send it). */
  allIds(max = Number.POSITIVE_INFINITY): string[] {
    const ids = [...this.byId.keys(), ...this.deleted];
    return ids.length > max ? ids.slice(ids.length - max) : ids;
  }

  /** Records (including tombstones) that a peer advertising `theirIds` is missing, oldest first. */
  missingFor(theirIds: ReadonlySet<string>): RoomRecord[] {
    const out: RoomRecord[] = [];
    for (const r of this.byId.values()) {
      if (!theirIds.has(r.id) && r.ts > this.clearedBefore) out.push(r);
    }
    return out.sort(compareRecords);
  }

  /** Every non-deleted file entry with its post, for the library. */
  fileEntries(): Array<{ meta: FileMeta; record: RoomRecord }> {
    const out: Array<{ meta: FileMeta; record: RoomRecord }> = [];
    for (const r of this.order) if (r.kind === 'file') for (const meta of r.files ?? []) out.push({ meta, record: r });
    return out;
  }

  fileMeta(fileId: string): FileMeta | undefined {
    for (const r of this.order) for (const f of r.files ?? []) if (f.fileId === fileId) return f;
    return undefined;
  }

  /** Local "clear history": drops everything at or before `ts` and ignores it if peers re-send it. */
  async clearHistory(ts: number = Date.now()): Promise<void> {
    this.clearedBefore = ts;
    const doomed = [...this.byId.values()].filter((r) => r.ts <= ts);
    for (const r of doomed) {
      this.byId.delete(r.id);
      await this.db.delete(r.id);
    }
    this.deleted.clear();
    this.tombs = new Map([...this.tombs].filter(([, l]) => l.some((t) => t.ts > ts)));
    this.order = [...this.byId.values()].filter((r) => r.kind !== 'delete' && r.ts > ts).sort(compareRecords);
    this.emit();
  }
}

/** Splits records into batches limited by count and serialised size. */
export function batchRecords(recs: RoomRecord[], maxCount: number, maxChars = 150_000): RoomRecord[][] {
  const batches: RoomRecord[][] = [];
  let cur: RoomRecord[] = [];
  let size = 0;
  for (const r of recs) {
    const len = JSON.stringify(r).length;
    if (cur.length && (cur.length >= maxCount || size + len > maxChars)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

import { useMemo, useState } from 'react';
import { Copy, Download, FolderOpen, Search, ShieldCheck, Trash2 } from 'lucide-react';
import type { FileMeta, RoomRecord } from '@lanshare/shared';
import { engine } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import { FILE_KIND_LABEL, fileKind, formatBytes, formatTime, formatDay, type FileKind } from '../../utils/format';
import { Button, EmptyState, Modal, Pill } from '../common/ui';
import { FileCard, availabilityInfo } from './FileCard';
import { FileIcon } from './FileIcon';

interface Entry {
  meta: FileMeta;
  record: RoomRecord;
  kind: FileKind;
}

type Sort = 'newest' | 'oldest' | 'size';

export function useFileEntries(): Entry[] {
  const records = useApp((s) => s.records);
  return useMemo(() => {
    const out: Entry[] = [];
    for (const r of records) if (r.kind === 'file') for (const meta of r.files ?? []) out.push({ meta, record: r, kind: fileKind(meta.name, meta.mime) });
    return out;
  }, [records]);
}

export function FilesLibrary() {
  const entries = useFileEntries();
  const avail = useApp((s) => s.avail);
  const myId = useApp((s) => s.identity?.peerId ?? '');
  const needsReshare = useApp((s) => s.needsReshare);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<FileKind | 'all'>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [onlyDupes, setOnlyDupes] = useState(false);
  const [details, setDetails] = useState<string | null>(null);

  const bySha = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.meta.sha256, (m.get(e.meta.sha256) ?? 0) + 1);
    return m;
  }, [entries]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = entries.filter((e) => (kind === 'all' || e.kind === kind) && (!needle || e.meta.name.toLowerCase().includes(needle)));
    if (onlyDupes) list = list.filter((e) => (bySha.get(e.meta.sha256) ?? 0) > 1);
    list = [...list].sort((a, b) => (sort === 'size' ? b.meta.size - a.meta.size : sort === 'oldest' ? a.record.ts - b.record.ts : b.record.ts - a.record.ts));
    return list;
  }, [entries, q, kind, sort, onlyDupes, bySha]);

  const kinds = useMemo(() => [...new Set(entries.map((e) => e.kind))], [entries]);
  const detail = details ? entries.find((e) => e.meta.fileId === details) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <label className="relative block">
          <span className="sr-only">Search files by name</span>
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files"
            className="h-10 w-full rounded-lg border border-line bg-surface-2 pr-3 pl-9 text-sm outline-none focus:border-brand"
            data-testid="file-search"
          />
        </label>
        <div className="flex gap-2">
          <select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value as FileKind | 'all')} className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-sm">
            <option value="all">All types</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {FILE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-sm">
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="size">Largest</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={onlyDupes} onChange={(e) => setOnlyDupes(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />
          Only show identical files (same SHA-256)
        </label>
      </div>

      {needsReshare > 0 && (
        <div className="m-3 rounded-lg bg-warn-soft p-3 text-xs text-warn">
          {needsReshare} file{needsReshare > 1 ? 's' : ''} you shared earlier {needsReshare > 1 ? 'are' : 'is'} not available from this device after the refresh.
          <Button size="sm" className="mt-2 w-full" onClick={() => void engine.restoreHandles()}>
            <FolderOpen size={14} /> Grant access and resume sharing
          </Button>
        </div>
      )}

      <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-3">
        {entries.length === 0 && (
          <EmptyState icon={<FolderOpen size={26} />} title="No files shared yet">
            Files posted to the room show up here. They stay on the sender's device until you download them.
          </EmptyState>
        )}
        {entries.length > 0 && shown.length === 0 && <p className="p-6 text-center text-sm text-muted">No files match your filters.</p>}
        {shown.map((e) => {
          const info = availabilityInfo(avail[e.meta.fileId], e.meta, myId);
          const dupes = bySha.get(e.meta.sha256) ?? 1;
          return (
            <button
              key={e.meta.fileId}
              type="button"
              onClick={() => setDetails(e.meta.fileId)}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-brand"
              data-testid="library-row"
            >
              <FileIcon name={e.meta.name} mime={e.meta.mime} size={40} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{e.meta.name}</span>
                <span className="block truncate text-xs text-muted">
                  {formatBytes(e.meta.size)} · {e.record.authorName} · {formatDay(e.record.ts)} {formatTime(e.record.ts)}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  <Pill tone={info.tone}>{info.tone === 'danger' ? 'Unavailable' : info.isLocal ? 'On this device' : 'Available'}</Pill>
                  {dupes > 1 && <Pill tone="brand">{dupes} identical</Pill>}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {detail && <FileDetails entry={detail} onClose={() => setDetails(null)} identical={entries.filter((e) => e.meta.sha256 === detail.meta.sha256 && e.meta.fileId !== detail.meta.fileId)} />}
    </div>
  );
}

export function FileDetails({ entry, identical, onClose }: { entry: Entry; identical: Entry[]; onClose: () => void }) {
  const { meta, record } = entry;
  const avail = useApp((s) => s.avail[meta.fileId]);
  const peers = useApp((s) => s.peers);
  const me = useApp((s) => s.identity?.peerId ?? '');
  const isAdmin = useApp((s) => s.room?.adminId === s.identity?.peerId);
  const canDeleteAll = record.authorId === me || isAdmin;
  const holderNames = (avail?.peers ?? []).map((p) => peers[p]?.name ?? 'peer');
  return (
    <Modal title="File details" onClose={onClose} wide>
      <FileCard meta={meta} />
      <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted">Shared by</dt>
        <dd>{record.authorName}</dd>
        <dt className="text-muted">Posted</dt>
        <dd>
          {formatDay(record.ts)}, {formatTime(record.ts)}
        </dd>
        <dt className="text-muted">Type</dt>
        <dd className="break-all">{meta.mime || 'unknown'}</dd>
        <dt className="text-muted">Size</dt>
        <dd>
          {formatBytes(meta.size)} ({meta.size.toLocaleString()} bytes)
        </dd>
        <dt className="text-muted">Online sources</dt>
        <dd>{avail?.local ? 'This device' : ''}{avail?.local && holderNames.length ? ', ' : ''}{holderNames.join(', ') || (avail?.local ? '' : 'none')}</dd>
        <dt className="flex items-center gap-1 text-muted">
          <ShieldCheck size={13} /> SHA-256
        </dt>
        <dd className="font-mono text-xs break-all">
          {meta.sha256}{' '}
          <button type="button" aria-label="Copy checksum" className="ml-1 inline-flex align-middle text-muted hover:text-ink" onClick={() => void navigator.clipboard?.writeText(meta.sha256)}>
            <Copy size={13} />
          </button>
        </dd>
        <dt className="text-muted">File ID</dt>
        <dd className="font-mono text-xs break-all">{meta.fileId}</dd>
      </dl>
      {identical.length > 0 && (
        <div className="mt-4 rounded-lg bg-brand-soft p-3 text-sm">
          <p className="font-medium">Identical files (same checksum)</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted">
            {identical.map((i) => (
              <li key={i.meta.fileId}>
                {i.meta.name} — {i.record.authorName}, {formatDay(i.record.ts)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
        {avail?.local && (
          <Button
            onClick={() => {
              void engine.stopSharing(meta.fileId);
              onClose();
            }}
          >
            Stop sharing from this device
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            void engine.deleteRecord(record.id, 'me');
            onClose();
          }}
          title="Hides this post on this device only"
        >
          Remove from my view
        </Button>
        {canDeleteAll && (
          <Button
            variant="danger"
            onClick={() => {
              if (confirm('Delete this post for everyone in the room? This cannot be undone.')) {
                void engine.deleteRecord(record.id, 'everyone');
                onClose();
              }
            }}
          >
            <Trash2 size={14} /> Delete for everyone
          </Button>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        <Download size={11} className="mr-1 inline" />
        “Remove from my view” is local only. “Delete for everyone” sends a signed tombstone that peers apply (author or room admin only).
      </p>
    </Modal>
  );
}

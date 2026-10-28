import { useMemo, useState } from 'react';
import { CheckCircle2, Download, HardDriveDownload, Share2, TriangleAlert, X } from 'lucide-react';
import type { FileMeta } from '@lanshare/shared';
import { engine } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import type { FileAvailability, TransferView } from '../../types';
import { formatBytes, formatEta, formatSpeed } from '../../utils/format';
import { Button, Pill, cx } from '../common/ui';
import { FileIcon } from './FileIcon';

export function availabilityInfo(avail: FileAvailability | undefined, meta: FileMeta, myId: string) {
  if (avail?.local) {
    return {
      tone: 'ok' as const,
      label: avail.localKind === 'replica' ? 'Stored on your device · sharing' : meta.uploaderId === myId ? 'Shared from your device' : 'On your device',
      canDownload: true,
      isLocal: true,
    };
  }
  const n = avail?.peers.length ?? 0;
  if (n > 0) return { tone: 'ok' as const, label: `Available · ${n} online peer${n > 1 ? 's' : ''}`, canDownload: true, isLocal: false };
  return { tone: 'danger' as const, label: 'File currently unavailable — no online peer has a copy.', canDownload: false, isLocal: false };
}

export function useFileTransfers(fileId: string) {
  const transfers = useApp((s) => s.transfers);
  return useMemo(() => {
    const all = Object.values(transfers).filter((t) => t.fileId === fileId);
    const down = all.filter((t) => t.direction === 'down').sort((a, b) => b.startedAt - a.startedAt)[0];
    const ups = all.filter((t) => t.direction === 'up' && !['done', 'failed', 'cancelled'].includes(t.state));
    return { down, ups };
  }, [transfers, fileId]);
}

export function ProgressLine({ t }: { t: TransferView }) {
  const pct = t.size > 0 ? Math.min(100, Math.floor((t.bytes / t.size) * 100)) : t.state === 'done' ? 100 : 0;
  const label =
    t.state === 'queued' ? 'Waiting in queue…' : t.state === 'requesting' ? 'Contacting peer…' : t.state === 'verifying' ? 'Verifying SHA-256…' : `${pct}% · ${formatBytes(t.bytes)} of ${formatBytes(t.size)}`;
  return (
    <div className="mt-2" data-testid="transfer-progress">
      <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-muted">
        <span>{label}</span>
        {(t.state === 'receiving' || t.state === 'sending') && (
          <span>
            {formatSpeed(t.speed)} · {formatEta(t.eta)} left
          </span>
        )}
      </div>
    </div>
  );
}

export function FileCard({ meta, onDetails }: { meta: FileMeta; onDetails?: () => void }) {
  const myId = useApp((s) => s.identity?.peerId ?? '');
  const avail = useApp((s) => s.avail[meta.fileId]);
  const replication = useApp((s) => s.settings.replicationEnabled);
  const showThumb = useApp((s) => s.settings.showThumbnails);
  const peers = useApp((s) => s.peers);
  const { down, ups } = useFileTransfers(meta.fileId);
  const [keep, setKeep] = useState(false);
  const info = availabilityInfo(avail, meta, myId);
  const active = down && !['done', 'failed', 'cancelled'].includes(down.state);
  const justDone = down?.state === 'done';
  const failed = down?.state === 'failed';

  return (
    <div className="w-full min-w-0 rounded-xl border border-line bg-surface p-3 text-ink shadow-card sm:min-w-72" data-testid="file-card">
      {showThumb && meta.thumb && (
        <button type="button" onClick={onDetails} className="mb-2 block w-full overflow-hidden rounded-lg bg-surface-2" aria-label={`Details of ${meta.name}`}>
          <img src={meta.thumb} alt={`Preview of ${meta.name}`} className="mx-auto max-h-48 w-auto object-contain" loading="lazy" />
        </button>
      )}
      <div className="flex items-start gap-3">
        <FileIcon name={meta.name} mime={meta.mime} />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onDetails} className="block max-w-full truncate text-left text-sm font-semibold hover:underline" title={meta.name}>
            {meta.name}
          </button>
          <div className="text-xs text-muted">{formatBytes(meta.size)}</div>
          <div className="mt-1.5">
            <Pill tone={info.tone}>
              {info.tone === 'danger' ? <TriangleAlert size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              {info.label}
            </Pill>
          </div>
        </div>
      </div>

      {active && <ProgressLine t={down} />}
      {failed && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-danger" role="alert">
          <TriangleAlert size={14} className="mt-px shrink-0" /> {down.error ?? 'Download failed'}
        </p>
      )}
      {justDone && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ok">
          <CheckCircle2 size={14} /> Downloaded and verified (SHA-256)
        </p>
      )}
      {ups.map((u) => (
        <div key={u.id} className="mt-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <Share2 size={12} /> {u.state === 'queued' ? 'Queued for' : 'Sending to'} {peers[u.peerId]?.name ?? 'peer'}
          </span>
          <ProgressLine t={u} />
          <button type="button" onClick={() => engine.cancelTransfer(u.id)} className="mt-1 text-[11px] text-danger underline">
            Stop sending
          </button>
        </div>
      ))}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {active ? (
          <Button size="sm" variant="danger" onClick={() => engine.cancelTransfer(down.id)} data-testid="cancel-download">
            <X size={14} /> Cancel
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={!info.canDownload} onClick={() => void engine.download(meta.fileId, keep)} data-testid="download-btn">
            {info.isLocal ? <HardDriveDownload size={14} /> : <Download size={14} />}
            {info.isLocal ? 'Save a copy' : failed ? 'Retry download' : 'Download'}
          </Button>
        )}
        {replication && !info.isLocal && !active && info.canDownload && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className={cx('h-4 w-4 accent-[var(--brand)]')} data-testid="keep-sharing" />
            Keep sharing this file
          </label>
        )}
      </div>
    </div>
  );
}

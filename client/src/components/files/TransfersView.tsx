import { useShallow } from 'zustand/react/shallow';
import { ArrowDownToLine, ArrowUpFromLine, Repeat2, X } from 'lucide-react';
import { engine } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import { Button, EmptyState, Pill } from '../common/ui';
import { FileIcon } from './FileIcon';
import { ProgressLine } from './FileCard';
import { formatBytes } from '../../utils/format';

export function TransfersView() {
  const transfers = useApp(useShallow((s) => Object.values(s.transfers)));
  const peers = useApp((s) => s.peers);
  const active = transfers.filter((t) => !['done', 'failed', 'cancelled'].includes(t.state)).sort((a, b) => b.startedAt - a.startedAt);
  const finished = transfers.filter((t) => ['done', 'failed', 'cancelled'].includes(t.state)).sort((a, b) => b.startedAt - a.startedAt);
  return (
    <div className="flex flex-col gap-4 p-4">
      {transfers.length === 0 && (
        <EmptyState icon={<Repeat2 size={26} />} title="No transfers yet">
          Files move directly between devices. Active uploads and downloads appear here with speed and time remaining.
        </EmptyState>
      )}
      {active.length > 0 && <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Active</h3>}
      {active.map((t) => (
        <Row key={t.id} t={t} peerName={peers[t.peerId]?.name} />
      ))}
      {finished.length > 0 && (
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Finished</h3>
          <Button size="sm" variant="ghost" onClick={() => engine.clearFinishedTransfers()}>
            Clear
          </Button>
        </div>
      )}
      {finished.map((t) => (
        <Row key={t.id} t={t} peerName={peers[t.peerId]?.name} />
      ))}
    </div>
  );
}

function Row({ t, peerName }: { t: ReturnType<typeof useApp.getState>['transfers'][string]; peerName?: string }) {
  const live = !['done', 'failed', 'cancelled'].includes(t.state);
  return (
    <div className="rounded-xl border border-line bg-surface p-3" data-testid="transfer-row">
      <div className="flex items-center gap-3">
        <FileIcon name={t.name} mime="" size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={t.name}>
            {t.name}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            {t.direction === 'down' ? <ArrowDownToLine size={12} /> : <ArrowUpFromLine size={12} />}
            {t.direction === 'down' ? 'from' : 'to'} {peerName ?? (t.peerId ? 'peer' : '…')} · {formatBytes(t.size)}
          </div>
        </div>
        {live ? (
          <Button size="sm" variant="danger" onClick={() => engine.cancelTransfer(t.id)}>
            <X size={14} /> Cancel
          </Button>
        ) : (
          <Pill tone={t.state === 'done' ? 'ok' : t.state === 'failed' ? 'danger' : 'neutral'}>{t.state}</Pill>
        )}
      </div>
      {live && <ProgressLine t={t} />}
      {t.error && !live && <p className="mt-2 text-xs text-danger">{t.error}</p>}
    </div>
  );
}

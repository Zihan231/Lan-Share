import { memo, useState } from 'react';
import { Check, CheckCheck, Copy, EyeOff, MoreVertical, Trash2 } from 'lucide-react';
import type { RoomRecord } from '@lanshare/shared';
import { engine } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import { formatTime, nameColorFor } from '../../utils/format';
import { FileCard } from '../files/FileCard';
import { FileDetails, useFileEntries } from '../files/FilesLibrary';
import { cx } from '../common/ui';

export const MessageBubble = memo(function MessageBubble({ rec, own, showName }: { rec: RoomRecord; own: boolean; showName: boolean }) {
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const isAdmin = useApp((s) => s.room?.adminId === s.identity?.peerId);
  const canDeleteAll = own || isAdmin;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rec.text ?? '');
      engine.toast('info', 'Copied to clipboard');
    } catch {
      engine.toast('error', 'Copy is blocked by the browser here; select the text manually.');
    }
    setMenu(false);
  };

  return (
    <div className={cx('group flex', own ? 'justify-end' : 'justify-start')} data-testid="message" data-own={own}>
      <div className={cx('relative max-w-[88%] min-w-0 rounded-2xl px-3 py-2 shadow-card sm:max-w-[72%]', own ? 'rounded-br-md bg-bubble-me' : 'rounded-bl-md bg-bubble-other')}>
        {showName && !own && (
          <div className="mb-0.5 truncate text-xs font-semibold" style={{ color: nameColorFor(rec.authorId) }}>
            {rec.authorName}
          </div>
        )}
        {rec.files && (
          <div className="mb-1 flex flex-col gap-2">
            {rec.files.map((f) => (
              <FileCard key={f.fileId} meta={f} onDetails={() => setDetails(f.fileId)} />
            ))}
          </div>
        )}
        {rec.text && <p className="text-[15px] leading-snug break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{rec.text}</p>}
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-muted">
          <time dateTime={new Date(rec.ts).toISOString()}>{formatTime(rec.ts)}</time>
          {own && <Delivery id={rec.id} />}
          <button
            type="button"
            aria-label="Message options"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            className="-my-1 rounded-full p-1 opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-70 dark:hover:bg-white/10"
          >
            <MoreVertical size={14} />
          </button>
        </div>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} aria-hidden />
            <div className={cx('pop absolute z-20 mt-1 w-56 rounded-xl border border-line bg-surface p-1 text-sm shadow-xl', own ? 'right-0' : 'left-0')} role="menu">
              {rec.text && (
                <MenuItem icon={<Copy size={15} />} onClick={() => void copy()}>
                  Copy text
                </MenuItem>
              )}
              <MenuItem
                icon={<EyeOff size={15} />}
                onClick={() => {
                  void engine.deleteRecord(rec.id, 'me');
                  setMenu(false);
                }}
              >
                Delete for me
              </MenuItem>
              {canDeleteAll && (
                <MenuItem
                  danger
                  icon={<Trash2 size={15} />}
                  onClick={() => {
                    setMenu(false);
                    if (confirm('Delete for everyone in the room?')) void engine.deleteRecord(rec.id, 'everyone');
                  }}
                >
                  Delete for everyone
                </MenuItem>
              )}
            </div>
          </>
        )}
      </div>
      {details && <DetailsHost fileId={details} onClose={() => setDetails(null)} />}
    </div>
  );
});

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={cx('flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left hover:bg-surface-2', danger && 'text-danger')}>
      {icon}
      {children}
    </button>
  );
}

function DetailsHost({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const entries = useFileEntries();
  const entry = entries.find((e) => e.meta.fileId === fileId);
  if (!entry) return null;
  return <FileDetails entry={entry} identical={entries.filter((e) => e.meta.sha256 === entry.meta.sha256 && e.meta.fileId !== fileId)} onClose={onClose} />;
}

/** Delivery state we can actually verify: how many peers acknowledged receipt of this record. */
function Delivery({ id }: { id: string }) {
  const acked = useApp((s) => s.acks[id]?.length ?? 0);
  const online = useApp((s) => Object.values(s.peers).filter((p) => p.conn === 'connected').length);
  if (acked > 0) {
    return (
      <span className="inline-flex items-center text-brand" title={`Delivered to ${acked} of ${Math.max(online, acked)} connected peer${online === 1 ? '' : 's'}`} data-testid="delivery" data-acked={acked}>
        <CheckCheck size={14} aria-label={`Delivered to ${acked}`} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center" title={online ? 'Sent, waiting for acknowledgement' : 'Saved on this device. No connected peers to deliver to yet; they will receive it when they sync.'} data-testid="delivery" data-acked={0}>
      <Check size={14} aria-label="Saved" />
    </span>
  );
}

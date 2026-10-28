import { CheckCircle2, Info, TriangleAlert, UserPlus, WifiOff, X } from 'lucide-react';
import { engine } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import { Avatar, Button, Modal, cx } from '../common/ui';

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-3 sm:bottom-6" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={cx(
            'pop pointer-events-auto flex max-w-md items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-xl ring-1',
            t.kind === 'error' ? 'bg-danger-soft text-danger ring-danger/30' : t.kind === 'success' ? 'bg-ok-soft text-ok ring-ok/30' : 'bg-surface text-ink ring-line',
          )}
        >
          {t.kind === 'error' ? <TriangleAlert size={16} className="mt-0.5 shrink-0" /> : t.kind === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <Info size={16} className="mt-0.5 shrink-0" />}
          <span className="flex-1">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => engine.dismissToast(t.id)} className="opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConnectionBanner() {
  const signaling = useApp((s) => s.signaling);
  const peerCount = useApp((s) => Object.keys(s.peers).length);
  const lan = useApp((s) => s.lanUrls[0]);
  if (signaling === 'disconnected' || signaling === 'connecting') {
    return (
      <div role="status" className="flex items-center gap-2 bg-warn-soft px-4 py-2 text-xs text-warn" data-testid="signaling-banner">
        <WifiOff size={14} className="shrink-0" />
        <span>
          Signaling server unreachable — retrying. Devices that are already connected can keep chatting and transferring files; new people cannot join until it is back.
        </span>
      </div>
    );
  }
  if (peerCount === 0) {
    return (
      <div className="bg-brand-soft px-4 py-2 text-xs text-brand">
        Waiting for others to join. On another device on this Wi-Fi, open <b className="font-mono">{lan ?? location.origin}</b>.
      </div>
    );
  }
  return null;
}

export function JoinRequests() {
  const reqs = useApp((s) => s.joinRequests);
  const first = reqs[0];
  if (!first) return null;
  return (
    <Modal title="Someone wants to join" onClose={() => engine.decideJoin(first.peerId, false)}>
      <div className="flex items-center gap-3">
        <Avatar id={first.peerId} name={first.name} size={48} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{first.name}</div>
          <div className="text-xs text-muted">
            <UserPlus size={12} className="mr-1 inline" />
            {reqs.length > 1 ? `${reqs.length - 1} more waiting` : 'Waiting for your approval'}
          </div>
        </div>
      </div>
      <p className="mt-3 rounded-lg bg-surface-2 p-3 text-xs text-muted">Anyone on this network who knows the address can ask to join. Only approve people you recognise; they will see the room's history and shared files.</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="danger" onClick={() => engine.decideJoin(first.peerId, false)} data-testid="decline-join">
          Decline
        </Button>
        <Button variant="primary" onClick={() => engine.decideJoin(first.peerId, true)} data-testid="approve-join">
          Approve
        </Button>
      </div>
    </Modal>
  );
}

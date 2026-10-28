import { Check, Copy, FolderOpen, QrCode, Repeat2, Settings as SettingsIcon, Wifi } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp, set, type Panel } from '../../stores/app';
import { encodeQr } from '../../utils/qr';
import { cx } from '../common/ui';
import { PeerList } from '../peers/PeerList';

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="var(--brand)" />
      <circle cx="20" cy="32" r="7" fill="var(--on-brand)" />
      <circle cx="44" cy="18" r="6" fill="var(--on-brand)" opacity=".75" />
      <circle cx="44" cy="46" r="6" fill="var(--on-brand)" opacity=".75" />
      <path d="M26 29l12-9M26 35l12 9" stroke="var(--on-brand)" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

export function roomTitle(id: string | undefined): string {
  return !id || id === 'lanshare' ? 'LANShare Room' : id;
}

export function Sidebar() {
  const room = useApp((s) => s.room);
  const panel = useApp((s) => s.panel);
  const signaling = useApp((s) => s.signaling);
  const activeTransfers = useApp((s) => Object.values(s.transfers).filter((t) => !['done', 'failed', 'cancelled'].includes(t.state)).length);
  const lanUrls = useApp((s) => s.lanUrls);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const nav: Array<{ id: Exclude<Panel, null | 'people'>; label: string; icon: typeof FolderOpen; badge?: number }> = [
    { id: 'files', label: 'Shared files', icon: FolderOpen },
    { id: 'transfers', label: 'Transfers', icon: Repeat2, badge: activeTransfers },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];
  const addr = lanUrls[0] ?? location.origin;
  const qrMatrix = useMemo(() => (showQr ? encodeQr(addr) : null), [showQr, addr]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line p-4">
        <Logo />
        <div className="min-w-0">
          <div className="text-base leading-tight font-bold">LANShare</div>
          <div className="flex items-center gap-1.5 truncate text-xs text-muted" data-testid="room-name">
            <span className={cx('h-2 w-2 shrink-0 rounded-full', signaling === 'connected' ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse')} />
            {roomTitle(room?.id)}
          </div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 p-2" aria-label="Sections">
        {nav.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => set({ panel: panel === n.id ? null : n.id })}
            aria-current={panel === n.id}
            data-testid={`nav-${n.id}`}
            className={cx('flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors', panel === n.id ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-surface-2')}
          >
            <n.icon size={18} />
            <span className="flex-1 text-left">{n.label}</span>
            {!!n.badge && <span className="rounded-full bg-brand px-1.5 text-xs text-on-brand">{n.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">People</div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <PeerList />
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
          <Wifi size={13} /> Invite devices on this network
        </div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1.5 text-xs" data-testid="lan-address" title={addr}>
            {addr}
          </code>
          <button
            type="button"
            aria-label="Copy address"
            title="Copy address"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 hover:bg-brand-soft"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(addr);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* clipboard blocked */
              }
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            aria-label={showQr ? 'Hide QR code' : 'Show QR code'}
            title={showQr ? 'Hide QR code' : 'Show QR code'}
            aria-expanded={showQr}
            data-testid="qr-button"
            className={cx(
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
              showQr ? 'bg-brand text-on-brand' : 'bg-surface-2 hover:bg-brand-soft',
            )}
            onClick={() => setShowQr((v) => !v)}
          >
            <QrCode size={14} />
          </button>
        </div>
        {showQr && qrMatrix && (
          <div className="mt-2.5 flex flex-col items-center rounded-xl bg-surface-2 p-3" data-testid="qr-code">
            <div className="rounded-lg bg-white p-2 shadow-sm">
              <QrSvg matrix={qrMatrix} size={156} />
            </div>
            <p className="mt-2 text-center text-[11px] text-muted">Scan with your phone camera on the same Wi-Fi</p>
          </div>
        )}
      </div>
    </div>
  );
}

function QrSvg({ matrix, size }: { matrix: boolean[][]; size: number }) {
  const n = matrix.length;
  const quiet = 2;
  const total = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) d += `M${c + quiet},${r + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${total} ${total}`} shapeRendering="crispEdges" role="img" aria-label="Invite QR code">
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

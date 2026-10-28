import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BadgeCheck, Crown, ShieldQuestion, Users } from 'lucide-react';
import { engine } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import type { PeerConn, UiPeer } from '../../types';
import { Avatar, Button, EmptyState, Modal, Pill, Switch } from '../common/ui';

const CONN_LABEL: Record<PeerConn, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  failed: 'Cannot connect directly',
  offline: 'Offline',
};

export function PeerList() {
  const peers = useApp(useShallow((s) => Object.values(s.peers)));
  const identity = useApp((s) => s.identity);
  const name = useApp((s) => s.name);
  const isAdmin = useApp((s) => s.room?.adminId === s.identity?.peerId);
  const [selected, setSelected] = useState<string | null>(null);
  const sorted = [...peers].sort((a, b) => Number(b.conn === 'connected') - Number(a.conn === 'connected') || a.name.localeCompare(b.name));
  const sel = selected ? useApp.getState().peers[selected] : undefined;

  return (
    <div className="flex flex-col gap-0.5" data-testid="peer-list">
      <div className="flex items-center gap-3 rounded-xl px-2 py-2">
        <Avatar id={identity?.peerId ?? 'me'} name={name || 'You'} status="online" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{name} <span className="font-normal text-muted">(you)</span></div>
          <div className="text-xs text-muted">{isAdmin ? 'Room admin' : 'Online'}</div>
        </div>
        {isAdmin && <Crown size={14} className="text-amber-500" aria-label="Room admin" />}
      </div>
      {sorted.length === 0 && (
        <EmptyState icon={<Users size={22} />} title="Nobody else is here yet">
          Share this page's address with devices on the same Wi-Fi.
        </EmptyState>
      )}
      {sorted.map((p) => (
        <button key={p.peerId} type="button" onClick={() => setSelected(p.peerId)} className="flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-2" data-testid="peer-row" data-conn={p.conn}>
          <Avatar id={p.peerId} name={p.name} status={p.conn === 'connected' ? 'online' : p.conn === 'connecting' || p.conn === 'reconnecting' ? 'connecting' : 'offline'} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{p.name}</span>
              {p.isAdmin && <Crown size={13} className="shrink-0 text-amber-500" aria-label="Room admin" />}
            </div>
            <div className="truncate text-xs text-muted">
              {CONN_LABEL[p.conn]}
              {p.sharedFiles > 0 && ` · ${p.sharedFiles} file${p.sharedFiles > 1 ? 's' : ''} shared`}
            </div>
          </div>
          {p.trusted ? (
            <BadgeCheck size={16} className="shrink-0 text-brand" aria-label="Trusted" />
          ) : (
            <ShieldQuestion size={16} className="shrink-0 text-muted" aria-label="Unverified" />
          )}
        </button>
      ))}
      {sel && <PeerDetails peer={sel} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PeerDetails({ peer, onClose }: { peer: UiPeer; onClose: () => void }) {
  const live = useApp((s) => s.peers[peer.peerId]) ?? peer;
  return (
    <Modal title={live.name} onClose={onClose}>
      <div className="flex items-center gap-3">
        <Avatar id={live.peerId} name={live.name} size={52} />
        <div className="flex flex-wrap gap-1.5">
          <Pill tone={live.conn === 'connected' ? 'ok' : 'warn'}>{CONN_LABEL[live.conn]}</Pill>
          {live.isAdmin && <Pill tone="brand">Room admin</Pill>}
          <Pill tone={live.trusted ? 'ok' : 'neutral'}>{live.trusted ? 'Trusted by you' : 'Unverified'}</Pill>
        </div>
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted">Safety code (derived from their public key)</dt>
          <dd className="font-mono text-base tracking-wide" data-testid="peer-fingerprint">
            {live.fingerprint}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Peer ID</dt>
          <dd className="font-mono text-xs break-all">{live.peerId}</dd>
        </div>
      </dl>
      <p className="mt-3 rounded-lg bg-surface-2 p-3 text-xs text-muted">
        Display names are not identities: anyone can pick any name. The safety code is tied to the cryptographic key that signs every message and authenticates the connection. Compare it in person (or over a call) before marking someone as trusted.
      </p>
      <label className="mt-4 flex items-center justify-between gap-3 text-sm">
        <span>Mark as trusted</span>
        <Switch checked={live.trusted} onChange={(v) => engine.setTrusted(live.peerId, v)} label="Mark as trusted" />
      </label>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

import { useShallow } from 'zustand/react/shallow';
import { FolderOpen, Repeat2, Settings, Users, WifiOff } from 'lucide-react';
import { set, useApp } from '../../stores/app';
import { Avatar, IconButton } from '../common/ui';
import { Logo, roomTitle } from './Sidebar';

export function ChatHeader() {
  const room = useApp((s) => s.room);
  const peers = useApp(useShallow((s) => Object.values(s.peers)));
  const signaling = useApp((s) => s.signaling);
  const active = useApp((s) => Object.values(s.transfers).filter((t) => !['done', 'failed', 'cancelled'].includes(t.state)).length);
  const connected = peers.filter((p) => p.conn === 'connected').length;
  const online = peers.length + 1;

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
      <div className="lg:hidden">
        <Logo size={32} />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base leading-tight font-semibold" data-testid="chat-title">
          {roomTitle(room?.id)}
        </h1>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted" data-testid="online-count">
          {signaling !== 'connected' && <WifiOff size={12} className="text-amber-500" />}
          {online} online{connected < peers.length ? ` · ${connected} directly connected` : ''}
        </p>
      </div>
      <div className="hidden items-center -space-x-2 sm:flex lg:hidden">
        {peers.slice(0, 4).map((p) => (
          <span key={p.peerId} className="rounded-full ring-2 ring-surface">
            <Avatar id={p.peerId} name={p.name} size={28} />
          </span>
        ))}
      </div>
      <IconButton label="People" className="lg:hidden" onClick={() => set({ panel: 'people' })} data-testid="open-people">
        <Users size={20} />
      </IconButton>
      <IconButton label="Shared files" onClick={() => set((s) => ({ panel: s.panel === 'files' ? null : 'files' }))} data-testid="open-files">
        <FolderOpen size={20} />
      </IconButton>
      <div className="relative lg:hidden">
        <IconButton label="Transfers" onClick={() => set({ panel: 'transfers' })}>
          <Repeat2 size={20} />
        </IconButton>
        {active > 0 && <span className="pointer-events-none absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-surface" />}
      </div>
      <IconButton label="Settings" className="lg:hidden" onClick={() => set({ panel: 'settings' })}>
        <Settings size={20} />
      </IconButton>
    </header>
  );
}

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { IconButton } from '../components/common/ui';
import { FilesLibrary } from '../components/files/FilesLibrary';
import { TransfersView } from '../components/files/TransfersView';
import { ChatHeader } from '../components/layout/ChatHeader';
import { ConnectionBanner, JoinRequests } from '../components/layout/Overlays';
import { SettingsView } from '../components/layout/SettingsView';
import { Sidebar } from '../components/layout/Sidebar';
import { PeerList } from '../components/peers/PeerList';
import { useMedia } from '../hooks/useMedia';
import { set, useApp } from '../stores/app';

const TITLES = { files: 'Shared files', transfers: 'Transfers', settings: 'Settings', people: 'People' } as const;

export function RoomPage() {
  const panel = useApp((s) => s.panel);
  const wide = useMedia('(min-width: 1280px)'); // right column fits beside chat
  const desktop = useMedia('(min-width: 1024px)'); // sidebar visible

  const showPanel = panel !== null && !(panel === 'people' && desktop);
  const body: ReactNode =
    panel === 'files' ? <FilesLibrary /> : panel === 'transfers' ? <TransfersView /> : panel === 'settings' ? <SettingsView /> : panel === 'people' ? <div className="p-3"><PeerList /></div> : null;

  const panelEl = panel && (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid={`panel-${panel}`}>
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="font-semibold">{TITLES[panel]}</h2>
        <IconButton label="Close panel" onClick={() => set({ panel: null })}>
          <X size={20} />
        </IconButton>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg">
      <aside className="hidden w-80 shrink-0 border-r border-line bg-surface lg:block" aria-label="Sidebar">
        <Sidebar />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader />
        <ConnectionBanner />
        <MessageList />
        <Composer />
      </main>
      {showPanel && wide && <aside className="w-[26rem] shrink-0 border-l border-line">{panelEl}</aside>}
      {showPanel && !wide && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && set({ panel: null })}>
          <aside className="pop h-full w-full max-w-md shadow-2xl">{panelEl}</aside>
        </div>
      )}
      <JoinRequests />
    </div>
  );
}

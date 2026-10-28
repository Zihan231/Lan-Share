import { useEffect } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Toasts } from './components/layout/Overlays';
import { JoinPage } from './pages/JoinPage';
import { RoomPage } from './pages/RoomPage';
import { engine } from './services/app/Engine';
import { useApp } from './stores/app';
import { applyTheme } from './utils/theme';

export default function App() {
  const phase = useApp((s) => s.phase);
  const loaded = useApp((s) => s.loaded);
  const bootError = useApp((s) => s.bootError);
  const theme = useApp((s) => s.settings.theme);

  useEffect(() => {
    void engine.boot();
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const m = matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system');
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [theme]);

  let body;
  if (bootError) {
    body = (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-line bg-surface p-6 text-center" role="alert">
          <TriangleAlert className="mx-auto mb-3 text-danger" />
          <h1 className="mb-1 text-lg font-semibold">LANShare can't start</h1>
          <p className="text-sm text-muted">Your browser blocked local storage (private mode or disabled site data). LANShare needs IndexedDB to keep your identity and messages. Details: {bootError}</p>
        </div>
      </div>
    );
  } else if (!loaded || phase === 'boot') {
    body = (
      <div className="flex min-h-dvh items-center justify-center text-muted">
        <Loader2 className="animate-spin" aria-label="Loading" />
      </div>
    );
  } else if (phase === 'room') body = <RoomPage />;
  else body = <JoinPage />;

  return (
    <>
      {body}
      <Toasts />
    </>
  );
}

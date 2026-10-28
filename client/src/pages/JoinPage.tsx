import { ChevronDown, Crown, Loader2, Lock, ShieldCheck, TriangleAlert, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEFAULT_ROOM_ID } from '@lanshare/shared';
import { Button, Pill, Switch } from '../components/common/ui';
import { Logo } from '../components/layout/Sidebar';
import { engine } from '../services/app/Engine';
import { useApp } from '../stores/app';

export function JoinPage() {
  const savedName = useApp((s) => s.name);
  const error = useApp((s) => s.joinError);
  const status = useApp((s) => s.joinStatus);
  const joining = useApp((s) => s.phase === 'joining');
  const secure = useApp((s) => s.secureContext);
  const isHost = useApp((s) => s.isHostDevice);
  const fp = useApp((s) => s.identity?.fingerprint);
  const [name, setName] = useState(savedName);
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState(DEFAULT_ROOM_ID);
  const [password, setPassword] = useState('');
  const [approval, setApproval] = useState(false);

  useEffect(() => {
    if (error && /password/i.test(error)) setOpen(true);
  }, [error]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void engine.join({
      name,
      roomId: room,
      password: password || undefined,
      requireApproval: isHost ? approval : undefined,
    });
  };

  return (
    <div className="chat-bg flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="pop w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-8" aria-labelledby="join-title">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 id="join-title" className="text-2xl font-bold tracking-tight">
                LANShare
              </h1>
              {isHost && (
                <Pill tone="brand" title="This browser is on the host computer running the server">
                  <Crown size={11} /> Host
                </Pill>
              )}
            </div>
            <p className="text-sm text-muted">Chat and share files on this network. No internet needed.</p>
          </div>
        </div>

        <label className="mb-1 block text-sm font-medium" htmlFor="name">
          Your display name
        </label>
        <input
          id="name"
          autoFocus
          required
          maxLength={32}
          autoComplete="nickname"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Zihan"
          className="h-11 w-full rounded-lg border border-line bg-surface-2 px-3 outline-none focus:border-brand"
          data-testid="join-name"
        />

        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-4 flex items-center gap-1 text-sm font-medium text-brand">
          <ChevronDown size={16} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} /> Room options
        </button>
        {open && (
          <div className="mt-3 space-y-3 rounded-xl bg-surface-2 p-4">
            <div>
              <label htmlFor="room" className="mb-1 block text-xs font-medium text-muted">
                Room ID
              </label>
              <input id="room" value={room} onChange={(e) => setRoom(e.target.value)} pattern="[a-zA-Z0-9_\-]{1,48}" className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm" data-testid="join-room" />
            </div>
            <div>
              <label htmlFor="pw" className="mb-1 flex items-center gap-1 text-xs font-medium text-muted">
                <Lock size={12} /> {isHost ? 'Room password (optional)' : 'Room password (if locked by host)'}
              </label>
              <input id="pw" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm" data-testid="join-password" />
              <p className="mt-1 text-[11px] text-muted">
                {isHost
                  ? 'As the host, you can set a password here or change/remove it anytime inside Settings.'
                  : 'Only needed if the host has locked this room with a password.'}
              </p>
            </div>
            {isHost && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Require approval for new people
                  <span className="block text-[11px] text-muted">Host control — you can also toggle this anytime after joining.</span>
                </span>
                <Switch checked={approval} onChange={setApproval} label="Require approval" />
              </label>
            )}
          </div>
        )}

        {error && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger" role="alert" data-testid="join-error">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        {status === 'awaiting-approval' && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-brand-soft p-3 text-sm text-brand" role="status">
            <Users size={16} className="mt-0.5 shrink-0" /> Waiting for the host to approve you…
          </p>
        )}

        <Button type="submit" variant="primary" className="mt-5 w-full" disabled={joining || !name.trim()} data-testid="join-submit">
          {joining ? (
            <>
              <Loader2 size={18} className="animate-spin" /> Joining…
            </>
          ) : (
            'Join room'
          )}
        </Button>

        <div className="mt-5 space-y-2 text-xs text-muted">
          <p className="flex items-start gap-2">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-brand" />
            <span>
              Messages and files go directly between devices, encrypted by WebRTC. The server only helps devices find each other and stores nothing. Your safety code: <span className="font-mono text-ink">{fp}</span>
            </span>
          </p>
          {!secure && (
            <p className="rounded-lg bg-warn-soft p-2 text-warn">
              You are on plain HTTP. Everything works, but this browser cannot stream large downloads straight to disk. Use the HTTPS address printed by the server for that (accept its one-time certificate warning).
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

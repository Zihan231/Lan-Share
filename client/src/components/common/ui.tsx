import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { colorFor, initials } from '../../utils/format';

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}

export function Avatar({ id, name, size = 36, status }: { id: string; name: string; size?: number; status?: 'online' | 'connecting' | 'offline' }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        aria-hidden
        className="inline-flex h-full w-full select-none items-center justify-center rounded-full font-semibold text-white"
        style={{ background: colorFor(id), fontSize: size * 0.38 }}
      >
        {initials(name)}
      </span>
      {status && (
        <span
          className={cx(
            'absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full ring-2 ring-surface',
            status === 'online' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-slate-400',
          )}
        />
      )}
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'soft' | 'danger'; size?: 'sm' | 'md' };

export function Button({ variant = 'soft', size = 'md', className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'min-h-8 px-2.5 text-xs' : 'min-h-10 px-3.5 text-sm',
        variant === 'primary' && 'bg-brand text-on-brand hover:bg-brand-hover',
        variant === 'soft' && 'bg-surface-2 text-ink hover:bg-brand-soft',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'bg-danger-soft text-danger hover:brightness-95',
        className,
      )}
    />
  );
}

export function IconButton({ label, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...p}
      aria-label={label}
      title={label}
      className={cx('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40', className)}
    >
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-brand' : 'bg-line')}
    >
      <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('pop max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-2xl outline-none sm:rounded-2xl', wide ? 'sm:max-w-xl' : 'sm:max-w-md')}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2">
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />;
}

export function Pill({ tone, children, title }: { tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'brand'; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'ok' && 'bg-ok-soft text-ok',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'danger' && 'bg-danger-soft text-danger',
        tone === 'neutral' && 'bg-surface-2 text-muted',
        tone === 'brand' && 'bg-brand-soft text-brand',
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">{icon}</div>
      <p className="font-semibold">{title}</p>
      {children && <p className="max-w-xs text-sm text-muted">{children}</p>}
    </div>
  );
}

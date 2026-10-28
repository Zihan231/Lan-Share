import { useEffect, useState, type ReactNode } from 'react';
import { HardDrive, Info, LogOut, Moon, Shield, Sun, Monitor, Trash2 } from 'lucide-react';
import { engine } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import { formatBytes } from '../../utils/format';
import { Button, Switch, cx } from '../common/ui';
import { applyTheme } from '../../utils/theme';
import { LIMITS } from '@lanshare/shared';

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

const numInput = 'h-9 w-24 rounded-lg border border-line bg-surface-2 px-2 text-right text-sm';

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const name = useApp((s) => s.name);
  const identity = useApp((s) => s.identity);
  const storage = useApp((s) => s.storage);
  const secure = useApp((s) => s.secureContext);
  const canSave = useApp((s) => s.canSaveToDisk);
  const room = useApp((s) => s.room);
  const [nameDraft, setNameDraft] = useState(name);
  useEffect(() => setNameDraft(name), [name]);
  useEffect(() => void engine.refreshStorage(), []);
  const cacheBytes = storage.replicas.reduce((n, r) => n + r.size, 0);

  return (
    <div className="space-y-4 p-4">
      <Section title="Profile" icon={<Info size={16} />}>
        <Row label="Display name" hint="Shown next to your messages. Not your identity.">
          <input
            value={nameDraft}
            maxLength={32}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => nameDraft.trim() && nameDraft !== name && void engine.setName(nameDraft)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="h-9 w-40 rounded-lg border border-line bg-surface-2 px-2 text-sm"
            aria-label="Display name"
          />
        </Row>
        <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
          Your safety code: <span className="font-mono text-ink">{identity?.fingerprint}</span>
          <br />
          Room: <span className="font-mono text-ink">{room?.id}</span>
          {room?.hasPassword && ' · password protected'}
          {room?.requireApproval && ' · admin approval required'}
        </div>
        <Row label="Theme">
          <div className="flex rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label="Theme">
            {([['system', Monitor], ['light', Sun], ['dark', Moon]] as const).map(([k, Icon]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={settings.theme === k}
                aria-label={k}
                onClick={() => {
                  applyTheme(k);
                  void engine.updateSettings({ theme: k });
                }}
                className={cx('flex h-8 w-9 items-center justify-center rounded-md', settings.theme === k ? 'bg-surface shadow-card' : 'text-muted')}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
        </Row>
        <Row label="Show image previews" hint="Small thumbnails embedded in posts.">
          <Switch checked={settings.showThumbnails} onChange={(v) => void engine.updateSettings({ showThumbnails: v })} label="Show image previews" />
        </Row>
      </Section>

      <Section title="File transfers" icon={<HardDrive size={16} />}>
        <Row label="Chunk size" hint="Bytes per message. 64 KB is a safe default.">
          <select
            value={settings.chunkSize}
            onChange={(e) => void engine.updateSettings({ chunkSize: Number(e.target.value) })}
            className="h-9 rounded-lg border border-line bg-surface-2 px-2 text-sm"
            aria-label="Chunk size"
          >
            {[16, 32, 64, 128].map((k) => (
              <option key={k} value={k * 1024}>
                {k} KB
              </option>
            ))}
            <option value={LIMITS.chunkMax}>256 KB (max)</option>
          </select>
        </Row>
        <Row label="Simultaneous uploads" hint="Extra requests wait in a queue.">
          <input type="number" min={1} max={10} value={settings.maxUploads} onChange={(e) => void engine.updateSettings({ maxUploads: clamp(+e.target.value, 1, 10) })} className={numInput} aria-label="Simultaneous uploads" />
        </Row>
        <Row label="Simultaneous downloads">
          <input type="number" min={1} max={10} value={settings.maxDownloads} onChange={(e) => void engine.updateSettings({ maxDownloads: clamp(+e.target.value, 1, 10) })} className={numInput} aria-label="Simultaneous downloads" />
        </Row>
        <Row label="Max file size (MB)" hint="Applies to posting and downloading. 0 = no app limit.">
          <input type="number" min={0} value={settings.maxFileSizeMB} onChange={(e) => void engine.updateSettings({ maxFileSizeMB: Math.max(0, +e.target.value || 0) })} className={numInput} aria-label="Max file size in MB" />
        </Row>
        <Row label="In-flight window (MB)" hint="Data allowed in flight before the receiver has stored it.">
          <input type="number" min={1} max={128} value={settings.windowMB} onChange={(e) => void engine.updateSettings({ windowMB: clamp(+e.target.value, 1, 128) })} className={numInput} aria-label="In-flight window in MB" />
        </Row>
        <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
          {canSave
            ? 'Downloads are streamed straight to a file you choose, so large files do not fill memory.'
            : 'This browser cannot stream to disk (no File System Access API' + (secure ? '' : '; also unavailable on plain HTTP') + '). Downloads are staged in browser storage and then saved, so you need free space of about the file size and very large files may fail.'}
        </p>
      </Section>

      <Section title="Sharing & storage" icon={<Shield size={16} />}>
        <Row label="Allow keeping files to share" hint="Opt-in per download via “Keep sharing this file”.">
          <Switch checked={settings.replicationEnabled} onChange={(v) => void engine.updateSettings({ replicationEnabled: v })} label="Allow keeping files to share" />
        </Row>
        <Row label="Cache limit (MB)">
          <input type="number" min={0} value={settings.storageLimitMB} onChange={(e) => void engine.updateSettings({ storageLimitMB: Math.max(0, +e.target.value || 0) })} className={numInput} aria-label="Cache limit in MB" />
        </Row>
        <div className="rounded-lg bg-surface-2 p-3 text-xs">
          <div className="flex justify-between">
            <span className="text-muted">Browser storage used (all LANShare data)</span>
            <span>
              {formatBytes(storage.usage)}
              {storage.quota > 0 && ` of ${formatBytes(storage.quota)}`}
            </span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="text-muted">Shared copies you keep</span>
            <span>
              {storage.replicas.length} · {formatBytes(cacheBytes)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-muted">Persistent storage</span>
            <span>{storage.persisted ? 'granted' : 'not granted (browser may evict)'}</span>
          </div>
        </div>
        {storage.replicas.map((r) => (
          <div key={r.fileId} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate" title={r.name}>
              {r.name} <span className="text-xs text-muted">{formatBytes(r.size)}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => void engine.stopSharing(r.fileId)}>
              Stop sharing
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {!storage.persisted && (
            <Button size="sm" onClick={() => void engine.requestPersistent()}>
              Request persistent storage
            </Button>
          )}
          <Button size="sm" onClick={() => void engine.clearCache()} disabled={!storage.replicas.length}>
            Remove all cached copies
          </Button>
        </div>
      </Section>

      <Section title="History & data" icon={<Trash2 size={16} />}>
        <Button
          onClick={() => confirm('Clear the chat history stored on this device? Other people keep theirs, and older messages will not be re-imported.') && void engine.clearLocalHistory()}
          className="w-full"
        >
          Clear local message history
        </Button>
        <p className="text-xs text-muted">Local only. It does not delete anything for other people; use “Delete for everyone” on a message for that.</p>
        <Button variant="danger" className="w-full" onClick={() => confirm('Erase your identity, history and cached files from this browser?') && void engine.resetEverything()}>
          Erase all LANShare data in this browser
        </Button>
      </Section>

      <Button variant="soft" className="w-full" onClick={() => engine.leave()}>
        <LogOut size={16} /> Leave room
      </Button>
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.round(n) : lo));

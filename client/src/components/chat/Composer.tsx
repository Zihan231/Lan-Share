import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Loader2, Paperclip, SendHorizontal, Smile, UploadCloud, X } from 'lucide-react';
import { LIMITS } from '@lanshare/shared';
import { engine, type PickedFile } from '../../services/app/Engine';
import { useApp } from '../../stores/app';
import { formatBytes } from '../../utils/format';
import { IconButton } from '../common/ui';
import { FileIcon } from '../files/FileIcon';
import { EmojiPicker } from './EmojiPicker';

export function Composer() {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<PickedFile[]>([]);
  const [emoji, setEmoji] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const hashing = useApp(useShallow((s) => Object.values(s.hashing)));
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

  const grow = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);
  useEffect(grow, [text, grow]);

  const addFiles = useCallback((files: PickedFile[]) => {
    setPending((p) => [...p, ...files].slice(0, LIMITS.filesPerPost));
  }, []);

  // Window-level drag & drop so files can be dropped anywhere on the chat.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) addFiles(files.map((file) => ({ file })));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles]);

  const pick = async () => {
    // Prefer the File System Access picker (Chromium, secure context): lets sharing resume after a refresh.
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({ multiple: true });
        addFiles(await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle }))));
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    fileInput.current?.click();
  };

  const send = async () => {
    if (busy) return;
    const t = text.trim();
    if (!t && !pending.length) return;
    setBusy(true);
    try {
      if (pending.length) {
        const files = pending;
        const caption = t;
        setPending([]);
        setText('');
        await engine.postFiles(files, caption);
      } else if (await engine.sendText(t)) setText('');
    } finally {
      setBusy(false);
      setEmoji(false);
      taRef.current?.focus();
    }
  };

  const insertEmoji = (e: string) => {
    const el = taRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + e + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + e.length, start + e.length);
    });
  };

  return (
    <div className="relative border-t border-line bg-surface safe-bottom">
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-brand/15 backdrop-blur-[2px]" aria-hidden>
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-brand bg-surface px-10 py-8 shadow-xl">
            <UploadCloud size={36} className="text-brand" />
            <p className="font-semibold">Drop files to share with the room</p>
            <p className="text-xs text-muted">Files stay on your device until someone downloads them.</p>
          </div>
        </div>
      )}

      {hashing.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted" role="status">
          <Loader2 size={14} className="animate-spin" />
          Preparing {hashing[0].name} ({hashing[0].pct}%){hashing.length > 1 ? ` + ${hashing.length - 1} more` : ''} — computing SHA-256 on your device
        </div>
      )}

      {pending.length > 0 && (
        <div className="scroll-thin flex gap-2 overflow-x-auto border-b border-line px-3 py-2" data-testid="pending-files">
          {pending.map((p, i) => (
            <div key={i} className="flex w-52 shrink-0 items-center gap-2 rounded-lg bg-surface-2 p-2">
              <FileIcon name={p.file.name} mime={p.file.type} size={32} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium" title={p.file.name}>
                  {p.file.name}
                </div>
                <div className="text-[11px] text-muted">{formatBytes(p.file.size)}</div>
              </div>
              <button type="button" aria-label={`Remove ${p.file.name}`} onClick={() => setPending((a) => a.filter((_, j) => j !== i))} className="rounded-full p-1 text-muted hover:bg-line">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {emoji && (
        <div className="absolute bottom-full left-2 z-30 mb-2">
          <EmojiPicker onPick={insertEmoji} />
        </div>
      )}

      <div className="flex items-end gap-1 p-2">
        <IconButton label="Emoji" onClick={() => setEmoji((v) => !v)} aria-expanded={emoji}>
          <Smile size={22} />
        </IconButton>
        <IconButton label="Attach files" onClick={() => void pick()} data-testid="attach-btn">
          <Paperclip size={22} />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          data-testid="file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) addFiles(files.map((file) => ({ file })));
            e.target.value = '';
          }}
        />
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          maxLength={LIMITS.textMax}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              addFiles(files.map((file) => ({ file: file.name ? file : new File([file], `pasted-${Date.now()}.${(file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')}`, { type: file.type }) })));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={pending.length ? 'Add a caption (optional)' : 'Type a message'}
          aria-label="Message"
          data-testid="composer-input"
          className="max-h-40 min-h-10 flex-1 resize-none rounded-2xl border border-line bg-surface-2 px-4 py-2.5 text-[15px] leading-5 outline-none focus:border-brand"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || (!text.trim() && !pending.length)}
          aria-label="Send"
          data-testid="send-btn"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand transition-opacity hover:bg-brand-hover disabled:opacity-40"
        >
          <SendHorizontal size={20} />
        </button>
      </div>
    </div>
  );
}

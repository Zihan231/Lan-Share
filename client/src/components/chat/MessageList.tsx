import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, MessageSquareText } from 'lucide-react';
import { useApp } from '../../stores/app';
import { formatDay } from '../../utils/format';
import { Button, EmptyState, Skeleton } from '../common/ui';
import { MessageBubble } from './MessageBubble';

const PAGE = 150;

type Item =
  | { type: 'day'; key: string; label: string }
  | { type: 'event'; key: string; text: string; ts: number }
  | { type: 'msg'; key: string; idx: number };

export function MessageList() {
  const records = useApp((s) => s.records);
  const events = useApp((s) => s.events);
  const myId = useApp((s) => s.identity?.peerId);
  const joining = useApp((s) => s.phase === 'joining');
  const [limit, setLimit] = useState(PAGE);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);
  const stick = useRef(true);

  const start = Math.max(0, records.length - limit);
  const items = useMemo(() => {
    const out: Item[] = [];
    const shownRecs = records.slice(start);
    const firstTs = shownRecs[0]?.ts ?? 0;
    const evs = events.filter((e) => e.ts >= firstTs);
    let ei = 0;
    let lastDay = '';
    const pushEventsBefore = (ts: number) => {
      while (ei < evs.length && evs[ei].ts <= ts) {
        out.push({ type: 'event', key: 'e' + evs[ei].id, text: evs[ei].text, ts: evs[ei].ts });
        ei++;
      }
    };
    shownRecs.forEach((r, i) => {
      pushEventsBefore(r.ts);
      const day = new Date(r.ts).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        out.push({ type: 'day', key: 'd' + day, label: formatDay(r.ts) });
      }
      out.push({ type: 'msg', key: r.id, idx: start + i });
    });
    pushEventsBefore(Number.POSITIVE_INFINITY);
    return out;
  }, [records, events, start]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Follow new content only if the user is already at the bottom; otherwise show a "new messages" chip.
  useLayoutEffect(() => {
    const added = records.length - prevLen.current;
    prevLen.current = records.length;
    if (stick.current) scrollToBottom();
    else if (added > 0) setUnseen((n) => n + added);
  }, [records.length, events.length, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAtBottom(near);
    if (near) setUnseen(0);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="scroll-thin chat-bg h-full overflow-y-auto px-3 py-4 sm:px-6" role="log" aria-live="polite" aria-label="Conversation" data-testid="message-list">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
          {joining && records.length === 0 && (
            <div className="space-y-3">
              <Skeleton className="h-12 w-2/3" />
              <Skeleton className="ml-auto h-10 w-1/2" />
              <Skeleton className="h-16 w-3/4" />
            </div>
          )}
          {!joining && records.length === 0 && (
            <EmptyState icon={<MessageSquareText size={26} />} title="No messages yet">
              Say hello, or drop a file here. Everything you post goes straight to the other devices on this network.
            </EmptyState>
          )}
          {start > 0 && (
            <Button variant="soft" size="sm" className="mx-auto mb-2" onClick={() => setLimit((l) => l + PAGE)}>
              Load earlier messages ({start})
            </Button>
          )}
          {items.map((it) => {
            if (it.type === 'day')
              return (
                <div key={it.key} className="my-2 flex justify-center">
                  <span className="rounded-full bg-surface px-3 py-1 text-[11px] font-medium text-muted shadow-card">{it.label}</span>
                </div>
              );
            if (it.type === 'event')
              return (
                <div key={it.key} className="my-1 flex justify-center" data-testid="system-event">
                  <span className="rounded-full bg-surface/80 px-3 py-0.5 text-[11px] text-muted">{it.text}</span>
                </div>
              );
            const rec = records[it.idx];
            const prev = records[it.idx - 1];
            return <MessageBubble key={it.key} rec={rec} own={rec.authorId === myId} showName={!prev || prev.authorId !== rec.authorId || rec.ts - prev.ts > 5 * 60_000} />;
          })}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            scrollToBottom(true);
            setUnseen(0);
          }}
          className="absolute right-4 bottom-4 inline-flex h-10 items-center gap-1.5 rounded-full bg-surface px-3 text-sm font-medium shadow-lg ring-1 ring-line"
          aria-label="Scroll to latest message"
        >
          <ArrowDown size={16} />
          {unseen > 0 && <span className="rounded-full bg-brand px-1.5 text-xs text-on-brand">{unseen}</span>}
        </button>
      )}
    </div>
  );
}

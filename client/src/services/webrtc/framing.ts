/**
 * DataChannel messages are only guaranteed to interoperate up to ~16 KiB. Control messages (history sync,
 * records) can be larger, so JSON is split into text fragments and reassembled on the other side.
 *
 * Wire format (strings): "J<json>" for a whole message, or "F<id>:<index>:<total>:<data>" for a fragment.
 */
export const FRAGMENT_SIZE = 12_000;
const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;
const MAX_PENDING = 32;

let counter = 0;

export function encodeMessage(msg: unknown, fragmentSize = FRAGMENT_SIZE): string[] {
  const json = JSON.stringify(msg);
  if (json.length <= fragmentSize) return ['J' + json];
  const id = (counter++ % 1_000_000).toString(36);
  const total = Math.ceil(json.length / fragmentSize);
  const out: string[] = [];
  for (let i = 0; i < total; i++) out.push(`F${id}:${i}:${total}:${json.slice(i * fragmentSize, (i + 1) * fragmentSize)}`);
  return out;
}

export class Reassembler {
  private pending = new Map<string, { parts: string[]; got: number; size: number }>();

  /** Returns the parsed message when complete, `undefined` while waiting, or throws on protocol violations. */
  push(raw: string): unknown | undefined {
    if (raw[0] === 'J') return JSON.parse(raw.slice(1));
    if (raw[0] !== 'F') throw new Error('unknown frame');
    const m = /^F([0-9a-z]{1,8}):(\d{1,6}):(\d{1,6}):/.exec(raw);
    if (!m) throw new Error('bad fragment header');
    const [head, id, iStr, tStr] = m;
    const i = Number(iStr);
    const total = Number(tStr);
    if (total < 2 || i >= total || total * 1 > MAX_MESSAGE_CHARS) throw new Error('bad fragment index');
    let p = this.pending.get(id);
    if (!p) {
      if (this.pending.size >= MAX_PENDING) throw new Error('too many partial messages');
      p = { parts: new Array(total), got: 0, size: 0 };
      this.pending.set(id, p);
    }
    if (p.parts.length !== total || p.parts[i] !== undefined) throw new Error('inconsistent fragment');
    const data = raw.slice(head.length);
    p.parts[i] = data;
    p.got++;
    p.size += data.length;
    if (p.size > MAX_MESSAGE_CHARS) throw new Error('message too large');
    if (p.got < total) return undefined;
    this.pending.delete(id);
    return JSON.parse(p.parts.join(''));
  }

  reset() {
    this.pending.clear();
  }
}

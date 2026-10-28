/**
 * The minimal DataChannel surface the app depends on. RTCDataChannel satisfies it structurally, and
 * tests use an in-memory implementation, so protocol logic can be exercised without a browser.
 */
export interface LinkChannel {
  readonly label: string;
  readonly readyState: string; // 'connecting' | 'open' | 'closing' | 'closed'
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onclose: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onbufferedamountlow: ((ev: any) => void) | null;
}

export const waitOpen = (ch: LinkChannel, timeoutMs = 15_000): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ch.readyState === 'open') return resolve();
    if (ch.readyState === 'closing' || ch.readyState === 'closed') return reject(new Error('channel closed'));
    const t = setTimeout(() => reject(new Error('channel open timeout')), timeoutMs);
    const prevOpen = ch.onopen;
    const prevClose = ch.onclose;
    ch.onopen = (e) => {
      clearTimeout(t);
      prevOpen?.(e);
      resolve();
    };
    ch.onclose = (e) => {
      clearTimeout(t);
      prevClose?.(e);
      reject(new Error('channel closed'));
    };
  });

/** Resolves when the channel's send buffer drains below its low-water mark (or immediately if already low). */
export function drain(ch: LinkChannel, high: number): Promise<void> {
  if (ch.bufferedAmount <= high) return Promise.resolve();
  return new Promise((resolve) => {
    const prev = ch.onbufferedamountlow;
    const done = () => {
      ch.onbufferedamountlow = prev;
      resolve();
    };
    ch.onbufferedamountlow = (e) => {
      prev?.(e);
      if (ch.bufferedAmount <= high || ch.readyState !== 'open') done();
    };
    // Safety net if the event never fires (channel closed mid-wait).
    const iv = setInterval(() => {
      if (ch.readyState !== 'open' || ch.bufferedAmount <= high) {
        clearInterval(iv);
        done();
      }
    }, 250);
  });
}

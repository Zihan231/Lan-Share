import type { LinkChannel } from '../../client/src/services/webrtc/channel';
import type { RtcPc } from '../../client/src/services/webrtc/PeerSession';

/** In-memory DataChannel pair: ordered, reliable, with a simulated send buffer (bufferedAmount). */
export class MemoryChannel implements LinkChannel {
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  onopen: LinkChannel['onopen'] = null;
  onclose: LinkChannel['onclose'] = null;
  onerror: LinkChannel['onerror'] = null;
  onmessage: LinkChannel['onmessage'] = null;
  onbufferedamountlow: LinkChannel['onbufferedamountlow'] = null;
  peer!: MemoryChannel;
  /** test knobs */
  dropOutgoing = false;
  tamper: ((data: string | ArrayBuffer) => string | ArrayBuffer) | null = null;
  delayMs = 0;

  constructor(readonly label: string) {}

  static pair(label: string): [MemoryChannel, MemoryChannel] {
    const a = new MemoryChannel(label);
    const b = new MemoryChannel(label);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  open() {
    for (const c of [this, this.peer]) {
      if (c.readyState === 'connecting') {
        c.readyState = 'open';
        c.onopen?.({});
      }
    }
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    if (this.dropOutgoing) return;
    let payload: string | ArrayBuffer;
    if (typeof data === 'string') payload = data;
    else if (data instanceof ArrayBuffer) payload = data.slice(0);
    else payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (this.tamper) payload = this.tamper(payload);
    const size = typeof payload === 'string' ? payload.length : payload.byteLength;
    this.bufferedAmount += size;
    const deliver = () => {
      this.bufferedAmount -= size;
      if (this.peer.readyState === 'open') this.peer.onmessage?.({ data: payload });
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.({});
    };
    if (this.delayMs) setTimeout(deliver, this.delayMs);
    else setTimeout(deliver, 0);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.({});
    setTimeout(() => {
      if (this.peer.readyState !== 'closed') {
        this.peer.readyState = 'closed';
        this.peer.onclose?.({});
      }
    }, 0);
  }
}

let pcCounter = 0;
const pcRegistry = new Map<string, FakePc>();

/** Fake RTCPeerConnection: SDP carries a pc id and a fake DTLS fingerprint; channels link up once both descriptions are set. */
export class FakePc implements RtcPc {
  readonly id = 'pc' + ++pcCounter;
  localDescription: { sdp: string } | null = null;
  remoteDescription: { sdp: string } | null = null;
  connectionState = 'new';
  iceConnectionState = 'new';
  onicecandidate: RtcPc['onicecandidate'] = null;
  ondatachannel: RtcPc['ondatachannel'] = null;
  onconnectionstatechange: RtcPc['onconnectionstatechange'] = null;
  oniceconnectionstatechange: RtcPc['oniceconnectionstatechange'] = null;
  remote: FakePc | null = null;
  private queued: MemoryChannel[] = [];
  closed = false;
  channels: MemoryChannel[] = [];

  constructor(public fingerprint = FakePc.randomFp()) {
    pcRegistry.set(this.id, this);
  }
  static randomFp() {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  }
  private sdp(kind: string) {
    return `v=0\r\na=x-pc:${this.id}\r\na=x-kind:${kind}\r\na=fingerprint:sha-256 ${this.fingerprint}\r\n`;
  }
  createDataChannel(label: string): LinkChannel {
    const [mine, theirs] = MemoryChannel.pair(label);
    this.channels.push(mine);
    if (this.remote) this.deliver(theirs);
    else this.queued.push(theirs);
    return mine;
  }
  private deliver(theirs: MemoryChannel) {
    const remote = this.remote!;
    setTimeout(() => {
      if (this.closed || remote.closed) return;
      remote.channels.push(theirs);
      remote.ondatachannel?.({ channel: theirs });
      theirs.open();
    }, 0);
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: this.sdp('offer') };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: this.sdp('answer') };
  }
  async setLocalDescription(d?: { type: 'offer' | 'answer'; sdp?: string }) {
    this.localDescription = { sdp: d?.sdp ?? this.sdp(d?.type ?? 'offer') };
  }
  async setRemoteDescription(d: { type: 'offer' | 'answer'; sdp: string }) {
    this.remoteDescription = { sdp: d.sdp };
    const id = /a=x-pc:(\S+)/.exec(d.sdp)?.[1];
    const remote = id ? pcRegistry.get(id) : undefined;
    if (!remote) throw new Error('unknown remote pc');
    this.remote = remote;
    if (d.type === 'answer') {
      // offerer got the answer: flush queued channels
      for (const q of this.queued.splice(0)) this.deliver(q);
      this.connectionState = remote.connectionState = 'connected';
    }
  }
  async addIceCandidate() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    for (const c of this.channels) c.close();
    this.onconnectionstatechange?.({});
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintOf, generateKeyPair, peerIdFromPublicKey, toB64u, type PeerInfo, type PeerMsg, type SignalPayload } from '@lanshare/shared';
import { Mesh, type PeerConnState } from '../client/src/services/webrtc/Mesh';
import type { PeerSession } from '../client/src/services/webrtc/PeerSession';
import { FakePc, MemoryChannel } from './helpers/memory';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 4000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await wait(5);
  }
};

interface Ident {
  kp: ReturnType<typeof generateKeyPair>;
  pk: string;
  id: string;
  name: string;
}
const ident = (name: string): Ident => {
  const kp = generateKeyPair();
  const pk = toB64u(kp.publicKey);
  return { kp, pk, id: peerIdFromPublicKey(pk), name };
};
const info = (i: Ident): PeerInfo => ({ peerId: i.id, name: i.name, publicKey: i.pk });

interface TestNode {
  who: Ident;
  mesh: Mesh;
  msgs: Array<{ from: string; msg: PeerMsg }>;
  states: Array<[string, PeerConnState]>;
  ready: string[];
  gone: Array<[string, string]>;
  pcs: FakePc[];
}

class Bus {
  nodes = new Map<string, TestNode>();
  down = false;
  rewrite: ((from: string, to: string, p: SignalPayload) => SignalPayload) | null = null;
  signals = 0;
  send = (from: string, to: string, payload: SignalPayload): boolean => {
    if (this.down) return false;
    this.signals++;
    const p = this.rewrite ? this.rewrite(from, to, payload) : payload;
    setTimeout(() => this.nodes.get(to)?.mesh.handleSignal(from, p), 1);
    return true;
  };
}

const timing = { authTimeoutMs: 1500, heartbeatMs: 40, deadAfterMs: 250 };
const meshes: Mesh[] = [];
afterEach(() => {
  meshes.splice(0).forEach((m) => m.dispose());
});

function node(bus: Bus, who: Ident, pcFactory?: () => FakePc): TestNode {
  const n: TestNode = { who, msgs: [], states: [], ready: [], gone: [], pcs: [], mesh: undefined as unknown as Mesh };
  n.mesh = new Mesh(
    { peerId: who.id, publicKey: who.pk, secretKey: who.kp.secretKey, getName: () => who.name },
    {
      sendSignal: (to, payload) => bus.send(who.id, to, payload),
      createPc: () => {
        const pc = pcFactory?.() ?? new FakePc();
        n.pcs.push(pc);
        return pc;
      },
      onPeerState: (id, s) => n.states.push([id, s]),
      onPeerReady: (s: PeerSession) => n.ready.push(s.peerId),
      onPeerGone: (id, reason) => n.gone.push([id, reason]),
      onMessage: (s, msg) => n.msgs.push({ from: s.peerId, msg }),
      onXferChannel: () => undefined,
    },
    timing,
  );
  meshes.push(n.mesh);
  bus.nodes.set(who.id, n);
  return n;
}

describe('peer connection lifecycle', () => {
  it('establishes an authenticated channel and exchanges messages (initiator chosen deterministically)', async () => {
    const bus = new Bus();
    const a = node(bus, ident('Alice'));
    const b = node(bus, ident('Bob'));
    a.mesh.addPeer(info(b.who));
    b.mesh.addPeer(info(a.who));
    await until(() => a.mesh.ready().length === 1 && b.mesh.ready().length === 1, 3000, 'both ready');
    expect(a.mesh.session(b.who.id)!.name).toBe('Bob');
    expect(a.mesh.session(b.who.id)!.fingerprint).toBe(fingerprintOf(b.who.pk));
    a.mesh.broadcast({ t: 'record', rec: { id: 'x' } as never });
    await until(() => b.msgs.length === 1, 1000, 'message');
    expect(b.msgs[0]).toMatchObject({ from: a.who.id, msg: { t: 'record' } });
    // only the smaller id created an offer
    const [init, resp] = a.who.id < b.who.id ? [a, b] : [b, a];
    expect(init.mesh.session(resp.who.id)!.role).toBe('initiator');
    expect(resp.mesh.session(init.who.id)!.role).toBe('responder');
  });

  it('does not drop an established session when the handshake timeout elapses (regression)', async () => {
    const bus = new Bus();
    const a = node(bus, ident('A'));
    const b = node(bus, ident('B'));
    a.mesh.addPeer(info(b.who));
    b.mesh.addPeer(info(a.who));
    await until(() => a.mesh.ready().length === 1 && b.mesh.ready().length === 1, 3000, 'connected');
    const sa = a.mesh.session(b.who.id);
    await wait(timing.authTimeoutMs + 600); // well past the handshake deadline
    expect(a.mesh.session(b.who.id)).toBe(sa);
    expect(sa!.ready).toBe(true);
    expect(a.gone).toHaveLength(0);
    expect(b.gone).toHaveLength(0);
  });

  it('forms a full mesh of five peers', async () => {
    const bus = new Bus();
    const nodes = ['A', 'B', 'C', 'D', 'E'].map((n) => node(bus, ident(n)));
    for (const n of nodes) for (const m of nodes) if (n !== m) n.mesh.addPeer(info(m.who));
    await until(() => nodes.every((n) => n.mesh.ready().length === 4), 5000, 'full mesh');
    // broadcast reaches everyone exactly once
    nodes[2].mesh.broadcast({ t: 'ping', n: 1 } as PeerMsg);
    nodes[2].mesh.broadcast({ t: 'profile', name: 'Zed' });
    await until(() => nodes.filter((n) => n !== nodes[2]).every((n) => n.msgs.some((m) => m.msg.t === 'profile')), 1000, 'broadcast');
    expect(nodes[0].msgs.filter((m) => m.msg.t === 'profile')).toHaveLength(1);
    expect(nodes[0].mesh.session(nodes[2].who.id)!.name).toBe('Zed');
  });

  it("keeps working when an unrelated peer disconnects", async () => {
    const bus = new Bus();
    const [a, b, c] = ['A', 'B', 'C'].map((n) => node(bus, ident(n)));
    for (const n of [a, b, c]) for (const m of [a, b, c]) if (n !== m) n.mesh.addPeer(info(m.who));
    await until(() => [a, b, c].every((n) => n.mesh.ready().length === 2), 4000, 'mesh');
    c.mesh.dispose();
    a.mesh.removePeer(c.who.id);
    b.mesh.removePeer(c.who.id);
    await wait(50);
    a.mesh.broadcast({ t: 'profile', name: 'still-here' });
    await until(() => b.msgs.some((m) => m.msg.t === 'profile'), 1000, 'delivery after a peer left');
    expect(a.mesh.ready().map((s) => s.peerId)).toEqual([b.who.id]);
  });

  it('refuses a peer that presents a different identity than signaling announced (impersonation)', async () => {
    const bus = new Bus();
    const alice = ident('Alice');
    const victim = ident('Victim'); // the identity signaling claims for the remote slot
    const impostor = ident('Impostor'); // the key the remote actually holds
    const a = node(bus, alice);
    // The impostor answers on the victim's peer id but can only authenticate with its own key.
    const fake = node(bus, { ...impostor, id: victim.id, pk: impostor.pk });
    a.mesh.addPeer({ peerId: victim.id, name: 'Victim', publicKey: victim.pk });
    fake.mesh.addPeer(info(alice));
    await wait(800);
    expect(a.mesh.ready()).toHaveLength(0);
    expect(fake.mesh.ready()).toHaveLength(0);
    expect([...a.gone, ...fake.gone].some(([, r]) => /bad-hello|auth-failed/.test(r))).toBe(true);
  });

  it('rejects a session whose DTLS fingerprints were swapped by a man-in-the-middle', async () => {
    const bus = new Bus();
    const a = node(bus, ident('A'));
    const b = node(bus, ident('B'));
    bus.rewrite = (_f, _t, p) => (p.kind === 'offer' || p.kind === 'answer' ? { ...p, sdp: p.sdp.replace(/a=fingerprint:sha-256 \S+/, 'a=fingerprint:sha-256 AA:BB:CC:DD') } : p);
    a.mesh.addPeer(info(b.who));
    b.mesh.addPeer(info(a.who));
    await wait(600);
    expect(a.mesh.ready()).toHaveLength(0);
    expect(b.mesh.ready()).toHaveLength(0);
    const closeReasons = [...a.gone, ...b.gone].map(([, r]) => r);
    expect(closeReasons.some((r) => /auth-failed|no-fingerprint/.test(r))).toBe(true);
  });

  it('ignores signals from peers that signaling never listed', async () => {
    const bus = new Bus();
    const a = node(bus, ident('A'));
    a.mesh.handleSignal('stranger-stranger-stranger', { kind: 'offer', sdp: 'v=0' });
    await wait(30);
    expect(a.mesh.sessionList).toHaveLength(0);
  });

  it('automatically reconnects after the data channel breaks', async () => {
    const bus = new Bus();
    const a = node(bus, ident('A'));
    const b = node(bus, ident('B'));
    a.mesh.addPeer(info(b.who));
    b.mesh.addPeer(info(a.who));
    await until(() => a.mesh.ready().length === 1, 3000, 'first connection');
    a.pcs.forEach((p) => p.close());
    await until(() => a.gone.length > 0, 1000, 'detect loss');
    await until(() => a.mesh.ready().length === 1 && b.mesh.ready().length === 1 && a.ready.length + b.ready.length >= 4, 6000, 'reconnected');
    a.mesh.broadcast({ t: 'profile', name: 'back' });
    await until(() => b.msgs.some((m) => m.msg.t === 'profile'), 1000, 'message after reconnect');
  });

  it('detects a silent peer through heartbeat timeout and recovers', async () => {
    const bus = new Bus();
    const a = node(bus, ident('A'));
    const b = node(bus, ident('B'));
    a.mesh.addPeer(info(b.who));
    b.mesh.addPeer(info(a.who));
    await until(() => a.mesh.ready().length === 1, 3000, 'connected');
    // everything the peers send now vanishes (e.g. Wi-Fi black hole)
    [...a.pcs, ...b.pcs].forEach((p) => p.channels.forEach((c: MemoryChannel) => (c.dropOutgoing = true)));
    await until(() => [...a.gone, ...b.gone].some(([, r]) => r === 'heartbeat-timeout'), 3000, 'heartbeat timeout');
    await until(() => a.mesh.ready().length === 1, 6000, 'recovery');
  });

  it('keeps established peer connections alive while signaling is down, and reconnects new peers when it returns', async () => {
    const bus = new Bus();
    const a = node(bus, ident('A'));
    const b = node(bus, ident('B'));
    const c = node(bus, ident('C'));
    a.mesh.addPeer(info(b.who));
    b.mesh.addPeer(info(a.who));
    await until(() => a.mesh.ready().length === 1, 3000, 'a-b');
    bus.down = true; // signaling server crashed
    // existing connection is unaffected
    a.mesh.broadcast({ t: 'profile', name: 'during-outage' });
    await until(() => b.msgs.some((m) => m.msg.t === 'profile'), 1000, 'p2p during outage');
    // a new peer cannot be reached while it is down
    a.mesh.addPeer(info(c.who));
    c.mesh.addPeer(info(a.who));
    await wait(400);
    expect(a.mesh.session(c.who.id)?.ready ?? false).toBe(false);
    // server returns: clients re-join and the mesh retries
    bus.down = false;
    a.mesh.retryAll();
    c.mesh.retryAll();
    await until(() => a.mesh.session(c.who.id)?.ready === true, 6000, 'late joiner connected');
    expect(a.mesh.session(b.who.id)!.ready).toBe(true);
  });

  it('replaces a stale session when a peer reconnects with a fresh offer', async () => {
    const bus = new Bus();
    const x = ident('X');
    const y = ident('Y');
    const [lo, hi] = x.id < y.id ? [x, y] : [y, x];
    const initiator = node(bus, lo);
    const responder = node(bus, hi);
    initiator.mesh.addPeer(info(hi));
    responder.mesh.addPeer(info(lo));
    await until(() => responder.mesh.ready().length === 1, 3000, 'first');
    const first = responder.mesh.session(lo.id);
    initiator.mesh.session(hi.id)!.close('simulated-refresh');
    await until(() => responder.mesh.session(lo.id) !== first && responder.mesh.session(lo.id)?.ready === true, 6000, 'second session');
  });

  it('stops reconnecting once a peer has left', async () => {
    const bus = new Bus();
    const a = node(bus, ident('A'));
    const b = node(bus, ident('B'));
    const [init, resp] = a.who.id < b.who.id ? [a, b] : [b, a];
    init.mesh.addPeer(info(resp.who));
    resp.mesh.addPeer(info(init.who));
    await until(() => init.mesh.ready().length === 1, 3000, 'connected');
    init.mesh.removePeer(resp.who.id);
    const before = init.pcs.length;
    await wait(900);
    expect(init.pcs.length).toBe(before);
    expect(init.mesh.sessionList).toHaveLength(0);
  });
});

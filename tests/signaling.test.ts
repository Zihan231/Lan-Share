import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  generateKeyPair,
  joinMessage,
  peerIdFromPublicKey,
  sign,
  toB64u,
  type JoinAck,
  type KeyPair,
  type SignalPayload,
} from '@lanshare/shared';
import { loadConfig } from '../server/src/config.js';
import { startServer, type RunningServer } from '../server/src/app.js';

let srv: RunningServer;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  const cfg = loadConfig({ PORT: '1', HTTPS: '0', HOST: '127.0.0.1' } as NodeJS.ProcessEnv);
  cfg.httpPort = 0 as number; // ephemeral
  cfg.approvalTimeoutMs = 3000;
  cfg.joinsPerMinute = 1000;
  srv = await startServer(cfg);
  url = `http://127.0.0.1:${srv.httpPort}`;
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await srv.close();
});

interface Client {
  s: Socket;
  kp: KeyPair;
  id: string;
  pub: string;
  nonce: string;
  events: Array<[string, ...unknown[]]>;
  join(opts?: { room?: string; password?: string; approval?: boolean; name?: string; sigKey?: KeyPair }): Promise<JoinAck>;
}

async function client(): Promise<Client> {
  const kp = generateKeyPair();
  const pub = toB64u(kp.publicKey);
  const s = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(s);
  const events: Client['events'] = [];
  s.onAny((ev, ...args) => events.push([ev, ...args]));
  const nonce = await new Promise<string>((res) => s.once('challenge', res));
  const c: Client = {
    s,
    kp,
    pub,
    id: peerIdFromPublicKey(kp.publicKey),
    nonce,
    events,
    join: (o = {}) =>
      new Promise((resolve) => {
        const room = o.room ?? 'room-a';
        s.emit(
          'join',
          {
            roomId: room,
            peerId: c.id,
            publicKey: pub,
            name: o.name ?? 'Tester',
            sig: sign(joinMessage(room, nonce), (o.sigKey ?? kp).secretKey),
            password: o.password,
            requireApproval: o.approval,
            protocol: PROTOCOL_VERSION,
          },
          resolve,
        );
      }),
  };
  return c;
}

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('signaling server', () => {
  it('serves health and info, and has no upload endpoint', async () => {
    expect(await (await fetch(`${url}/healthz`)).text()).toBe('ok');
    const info = await (await fetch(`${url}/api/info`)).json();
    expect(info.name).toBe('LANShare');
    const up = await fetch(`${url}/upload`, { method: 'POST', body: 'x' });
    expect(up.status).not.toBe(200);
    expect((await fetch(`${url}/healthz`)).headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('lets peers join, announces presence and relays signals', async () => {
    const a = await client();
    const b = await client();
    const ra = await a.join({ room: 'presence', name: 'Alice' });
    expect(ra.ok && ra.adminId).toBe(a.id);
    const rb = await b.join({ room: 'presence', name: 'Bob' });
    expect(rb.ok && rb.peers.map((p) => p.peerId)).toEqual([a.id]);
    await waitFor(() => a.events.some((e) => e[0] === 'peer-joined'));

    const offer: SignalPayload = { kind: 'offer', sdp: 'v=0 fake' };
    b.s.emit('signal', a.id, offer);
    await waitFor(() => a.events.some((e) => e[0] === 'signal'));
    expect(a.events.find((e) => e[0] === 'signal')!.slice(1)).toEqual([b.id, offer]);

    b.s.close();
    await waitFor(() => a.events.some((e) => e[0] === 'peer-left' && e[1] === b.id));
  });

  it('rejects an impersonation attempt (valid key, wrong signature)', async () => {
    const victim = await client();
    const attacker = await client();
    // attacker claims the victim's peerId/publicKey but can only sign with its own key
    const res = await new Promise<JoinAck>((resolve) =>
      attacker.s.emit(
        'join',
        {
          roomId: 'imp',
          peerId: victim.id,
          publicKey: victim.pub,
          name: 'Victim',
          sig: sign(joinMessage('imp', attacker.nonce), attacker.kp.secretKey),
          protocol: PROTOCOL_VERSION,
        },
        resolve,
      ),
    );
    expect(res).toEqual({ ok: false, error: 'bad-signature' });
    // peerId that does not match the key
    const res2 = await new Promise<JoinAck>((resolve) =>
      attacker.s.emit(
        'join',
        { roomId: 'imp', peerId: victim.id, publicKey: attacker.pub, name: 'x', sig: sign(joinMessage('imp', attacker.nonce), attacker.kp.secretKey), protocol: PROTOCOL_VERSION },
        resolve,
      ),
    );
    expect(res2).toEqual({ ok: false, error: 'invalid' });
  });

  it('does not allow replaying a signature captured on another connection', async () => {
    const a = await client();
    const a2 = await client(); // same identity would need a different nonce
    const sig = sign(joinMessage('replay', a.nonce), a.kp.secretKey);
    const res = await new Promise<JoinAck>((resolve) =>
      a2.s.emit('join', { roomId: 'replay', peerId: a.id, publicKey: a.pub, name: 'x', sig, protocol: PROTOCOL_VERSION }, resolve),
    );
    expect(res).toEqual({ ok: false, error: 'bad-signature' });
  });

  it('enforces room passwords', async () => {
    const owner = await client();
    expect((await owner.join({ room: 'secret', password: 'hunter2' })).ok).toBe(true);
    const guest = await client();
    expect(await guest.join({ room: 'secret' })).toEqual({ ok: false, error: 'password-required' });
    expect(await guest.join({ room: 'secret', password: 'nope' })).toEqual({ ok: false, error: 'bad-password' });
    expect((await guest.join({ room: 'secret', password: 'hunter2' })).ok).toBe(true);
  });

  it('supports admin approval of new participants', async () => {
    const admin = await client();
    await admin.join({ room: 'gated', approval: true });
    const guest = await client();
    const pending = guest.join({ room: 'gated', name: 'Guest' });
    await waitFor(() => admin.events.some((e) => e[0] === 'join-request'));
    admin.s.emit('decide', guest.id, true);
    const res = await pending;
    expect(res.ok).toBe(true);

    const intruder = await client();
    const p2 = intruder.join({ room: 'gated' });
    await waitFor(() => admin.events.filter((e) => e[0] === 'join-request').length === 2);
    admin.s.emit('decide', intruder.id, false);
    expect(await p2).toEqual({ ok: false, error: 'denied' });

    // a non-admin cannot approve
    const x = await client();
    const p3 = x.join({ room: 'gated' });
    await waitFor(() => admin.events.filter((e) => e[0] === 'join-request').length === 3);
    guest.s.emit('decide', x.id, true);
    admin.s.emit('decide', x.id, false);
    expect(await p3).toEqual({ ok: false, error: 'denied' });
  });

  it('refuses to relay signals across rooms or malformed payloads', async () => {
    const a = await client();
    const b = await client();
    await a.join({ room: 'iso-1' });
    await b.join({ room: 'iso-2' });
    b.s.emit('signal', a.id, { kind: 'offer', sdp: 'x' });
    b.s.emit('signal', a.id, { kind: 'bogus' });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.events.some((e) => e[0] === 'signal')).toBe(false);

    const c = await client();
    await c.join({ room: 'iso-1' });
    c.s.emit('signal', a.id, { kind: 'offer', sdp: 'x'.repeat(30_000) });
    c.s.emit('signal', a.id, { kind: 'offer', sdp: '<script>' });
    await waitFor(() => a.events.filter((e) => e[0] === 'signal').length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.events.filter((e) => e[0] === 'signal')).toHaveLength(1);
  });

  it('replaces a stale session when the same identity re-joins and elects a new admin on leave', async () => {
    const a = await client();
    const b = await client();
    await a.join({ room: 'swap' });
    await b.join({ room: 'swap' });
    a.s.close();
    await waitFor(() => b.events.some((e) => e[0] === 'admin' && e[1] === b.id));
  });

  it('lets the host dynamically change room password, toggle approval, and kick users', async () => {
    const host = await client();
    const guest = await client();
    await host.join({ room: 'host-ctl' });
    await guest.join({ room: 'host-ctl' });

    // Non-admin cannot change password or kick
    guest.s.emit('room-config', { password: 'hacked' });
    guest.s.emit('kick', host.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(host.events.some((e) => e[0] === 'kicked')).toBe(false);

    // Host sets a password on the already-created room
    host.s.emit('room-config', { password: 'newpw', requireApproval: true });
    await waitFor(() => guest.events.some((e) => e[0] === 'room-updated' && (e[1] as { hasPassword: boolean }).hasPassword === true));

    const late = await client();
    expect(await late.join({ room: 'host-ctl' })).toEqual({ ok: false, error: 'password-required' });

    // Host kicks guest
    host.s.emit('kick', guest.id);
    await waitFor(() => guest.events.some((e) => e[0] === 'kicked'));

    // Host removes password and disables approval
    host.s.emit('room-config', { password: null, requireApproval: false });
    await waitFor(() => host.events.some((e) => e[0] === 'room-updated' && (e[1] as { hasPassword: boolean }).hasPassword === false));
    const late2 = await client();
    expect((await late2.join({ room: 'host-ctl' })).ok).toBe(true);
  });

  it('automatically falls back to the 2nd or 3rd port if the primary port is already in use', async () => {
    // srv is already occupying srv.httpPort on 127.0.0.1
    const busyPort = srv.httpPort;
    const cfg2 = loadConfig({ PORT: `${busyPort},${busyPort + 1},${busyPort + 2}`, HTTPS: '0', HOST: '127.0.0.1' } as NodeJS.ProcessEnv);
    const srv2 = await startServer(cfg2);
    try {
      expect(srv2.httpPort).toBeGreaterThan(busyPort);
      expect([busyPort + 1, busyPort + 2]).toContain(srv2.httpPort);
    } finally {
      await srv2.close();
    }
  });
});

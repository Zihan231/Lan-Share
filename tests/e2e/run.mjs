// End-to-end scenarios in real Chrome instances (separate profiles) against the real server.
// Usage: npm run build && npm run test:e2e        (env: BIG_MB=200 to change the large-file size)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server, User, launch, lanIp, makeFile, runner, sha256File, sleep, until } from './harness.mjs';

const PORT = 3217;
const HTTPS_PORT = 3617;
const ip = lanIp();
const HTTP = `http://${ip}:${PORT}`; // plain-HTTP LAN origin => NOT a secure context (the hard case)
const HTTPS = `https://${ip}:${HTTPS_PORT}`;
const BIG_MB = Number(process.env.BIG_MB ?? 200);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lanshare-e2e-'));
const r = runner('LANShare end-to-end');

const server = new Server(PORT, HTTPS_PORT);
await server.start();
const browser = await launch();
const users = [];
const mkUser = async (name, base = HTTP, opts) => {
  const u = new User(browser, name);
  users.push(u);
  await u.open(base, opts);
  return u;
};
const download = async (user, fileName, { keep = false } = {}) => {
  const card = user.card(fileName);
  if (keep) await card.getByTestId('keep-sharing').check();
  const [dl] = await Promise.all([user.page.waitForEvent('download', { timeout: 120_000 }), card.getByTestId('download-btn').click()]);
  const out = path.join(tmp, `${user.name}-${Date.now()}-${fileName}`);
  await dl.saveAs(out);
  return out;
};

console.log(`\nServer ${HTTP} (secure context: no) | ${HTTPS}\n`);

try {
  const alice = await mkUser('Alice');
  const bob = await mkUser('Bob');
  let carol, dave, eve;

  await r.step('1. two users join and see each other connect over WebRTC', async () => {
    await alice.join();
    await alice.joined();
    await bob.join();
    await bob.joined();
    await alice.waitConnected(1);
    await bob.waitConnected(1);
    assert.equal(await alice.page.evaluate(() => window.isSecureContext), false, 'test must run in a non-secure context');
  });

  await r.step('2. users exchange messages, multiline + emoji, with delivery state', async () => {
    await alice.say('Hello Bob 👋\nsecond line');
    await bob.waitMessage('Hello Bob 👋');
    const msg = (await bob.messages()).find((m) => m.includes('Hello Bob'));
    assert.match(msg, /second line/);
    await until(async () => (await alice.page.getByTestId('delivery').last().getAttribute('data-acked')) === '1', 8000, 'delivery ack');
    await bob.say('Hi Alice!');
    await alice.waitMessage('Hi Alice!');
  });

  await r.step('3. five users join one group and form a full mesh', async () => {
    carol = await mkUser('Carol');
    dave = await mkUser('Dave');
    eve = await mkUser('Eve');
    for (const u of [carol, dave, eve]) {
      await u.join();
      await u.joined();
    }
    for (const u of [alice, bob, carol, dave, eve]) await u.waitConnected(4, 30000);
    await eve.say('Eve here');
    for (const u of [alice, bob, carol, dave]) await u.waitMessage('Eve here');
    assert.match(await alice.page.getByTestId('online-count').innerText(), /5 online/);
  });

  await r.step('4. new users synchronise earlier history (late joiner)', async () => {
    const frank = await mkUser('Frank');
    await frank.join();
    await frank.joined();
    await frank.waitConnected(5, 30000);
    await frank.waitMessage('Hello Bob 👋');
    await frank.waitMessage('Eve here');
    const msgs = await frank.messages();
    assert.equal(msgs.filter((m) => m.includes('Hi Alice!')).length, 1, 'no duplicate after sync');
  });

  const small = makeFile(tmp, 'project-final.zip', 3 * 1024 * 1024 + 123, 7);
  await r.step('5. a user posts a file; another downloads it on demand and the bytes are identical', async () => {
    await alice.post(small.file, 'Project files for everyone.');
    await bob.card('project-final.zip').waitFor({ timeout: 15000 });
    const text = await bob.card('project-final.zip').innerText();
    assert.match(text, /3\.00 MB/);
    assert.match(text, /Available/);
    // not auto-downloaded: bob has no transfers yet
    assert.equal(await bob.page.getByTestId('transfer-progress').count(), 0);
    const out = await download(bob, 'project-final.zip');
    assert.equal(await sha256File(out), small.sha256);
    await bob.card('project-final.zip').getByText('Downloaded and verified').waitFor();
  });

  await r.step('6. two users download the same file at the same time', async () => {
    const [a, b] = await Promise.all([download(carol, 'project-final.zip'), download(dave, 'project-final.zip')]);
    assert.equal(await sha256File(a), small.sha256);
    assert.equal(await sha256File(b), small.sha256);
  });

  await r.step(`7. a large file (${BIG_MB} MB) transfers with progress, speed and a matching SHA-256`, async () => {
    const big = makeFile(tmp, 'dataset-large.bin', BIG_MB * 1024 * 1024, 99);
    await alice.post(big.file);
    await eve.card('dataset-large.bin').waitFor({ timeout: 180_000 });
    const t0 = Date.now();
    const card = eve.card('dataset-large.bin');
    const dlP = Promise.all([eve.page.waitForEvent('download', { timeout: 300_000 }), card.getByTestId('download-btn').click()]);
    await card.getByTestId('transfer-progress').waitFor({ timeout: 30000 });
    const seen = await until(async () => {
      const t = await card.getByTestId('transfer-progress').innerText().catch(() => '');
      return /MB\/s|KB\/s/.test(t) ? t : false;
    }, 60000, 'speed readout');
    assert.match(seen, /left/);
    const [dl] = await dlP;
    const out = path.join(tmp, 'eve-big.bin');
    await dl.saveAs(out);
    const secs = (Date.now() - t0) / 1000;
    console.log(`      ${BIG_MB} MB in ${secs.toFixed(1)} s (${(BIG_MB / secs).toFixed(1)} MB/s)`);
    assert.equal(await sha256File(out), big.sha256);
    fs.rmSync(big.file);
    fs.rmSync(out);
  });

  await r.step('8. cancelling a download works and leaves the file downloadable again', async () => {
    const f = makeFile(tmp, 'cancel-me.bin', 120 * 1024 * 1024, 5);
    await alice.post(f.file);
    await bob.card('cancel-me.bin').waitFor({ timeout: 120_000 });
    const card = bob.card('cancel-me.bin');
    await card.getByTestId('download-btn').click();
    await card.getByTestId('cancel-download').waitFor({ timeout: 20000 });
    await card.getByTestId('cancel-download').click();
    await card.getByTestId('download-btn').waitFor({ timeout: 10000 });
    await until(async () => (await alice.page.getByTestId('transfer-row').count()) >= 0, 2000);
    fs.rmSync(f.file);
  });

  await r.step('9. replication is opt-in: a kept copy keeps the file available after the uploader leaves', async () => {
    const rep = makeFile(tmp, 'keepable.pdf', 2 * 1024 * 1024, 11);
    await alice.post(rep.file, 'please keep this one');
    await bob.card('keepable.pdf').waitFor({ timeout: 15000 });
    await download(bob, 'keepable.pdf', { keep: true });
    await bob.card('keepable.pdf').getByText(/sharing/i).first().waitFor({ timeout: 15000 });
    // carol learns that two peers have it
    await until(async () => /2 online peers/.test(await carol.card('keepable.pdf').innerText()), 15000, 'two holders announced');
    await alice.close(); // uploader goes offline (tab closed)
    await until(async () => /1 online peer\b/.test(await carol.card('keepable.pdf').innerText()), 20000, 'availability drops to the replica only');
    // the replica is durable: the holder refreshes its page and still serves the file
    await bob.page.reload();
    await bob.page.getByTestId('chat-title').waitFor({ timeout: 15000 });
    await bob.waitConnected(2, 30000);
    await until(async () => /1 online peer\b/.test(await carol.card('keepable.pdf').innerText()), 20000, 'replica re-announced after refresh');
    const out = await download(carol, 'keepable.pdf');
    assert.equal(await sha256File(out), rep.sha256);
  });

  await r.step('10. a file whose only holder is offline shows "unavailable" and the download is disabled', async () => {
    // alice's earlier files have no other holder except downloaders; use cancel-me.bin (bob cancelled, nobody else has it)
    const card = carol.card('cancel-me.bin');
    await card.waitFor({ timeout: 10000 });
    await until(async () => /File currently unavailable/.test(await card.innerText()), 20000, 'unavailable label');
    assert.equal(await card.getByTestId('download-btn').isDisabled(), true);
  });

  await r.step('11. a user closes their browser while the others stay connected and keep chatting', async () => {
    await dave.close();
    await until(async () => /4 online/.test(await bob.page.getByTestId('online-count').innerText()), 20000, 'presence update');
    await bob.say('still here after dave left');
    await carol.waitMessage('still here after dave left');
    assert.ok(await bob.page.getByTestId('system-event').filter({ hasText: 'Dave left' }).count());
  });

  await r.step('12. a refresh restores local history instantly and reconnects without duplicating anything', async () => {
    const before = (await bob.messages()).length;
    await bob.page.reload();
    await bob.page.getByTestId('chat-title').waitFor({ timeout: 15000 });
    // history is rendered from IndexedDB before/without peers
    assert.ok((await bob.messages()).length >= before - 1, 'history restored');
    await bob.waitConnected(2, 30000);
    await sleep(1500); // let sync settle
    const after = await bob.messages();
    assert.equal(after.filter((m) => m.includes('Hello Bob 👋')).length, 1, 'no duplicates after resync');
    assert.equal(after.filter((m) => m.includes('Eve here')).length, 1);
  });

  await r.step('13. malicious message content is rendered as inert text', async () => {
    const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script><b>bold?</b>';
    await eve.say(payload);
    await bob.waitMessage('<img src=x');
    for (const u of [bob, carol, eve]) assert.equal(await u.page.evaluate(() => window.__xss), undefined, 'script must not run');
    assert.equal(await bob.page.locator('[data-testid=message] img').count(), 0);
    assert.equal(await bob.page.locator('[data-testid=message] b').count(), 0);
  });

  await r.step('14. an interrupted transfer fails cleanly with a clear error, and can be retried from another peer', async () => {
    const f = makeFile(tmp, 'interrupt.bin', 150 * 1024 * 1024, 21);
    await eve.post(f.file);
    await carol.card('interrupt.bin').waitFor({ timeout: 120_000 });
    const card = carol.card('interrupt.bin');
    await card.getByTestId('download-btn').click();
    await until(async () => /\d+%/.test(await card.getByTestId('transfer-progress').innerText().catch(() => '')), 30000, 'progress');
    await eve.close(); // network interruption: the only source disappears mid-transfer
    await card.getByRole('alert').waitFor({ timeout: 40000 });
    assert.match(await card.innerText(), /closed|disconnected|No online peer|failed/i);
    await until(async () => /unavailable/.test(await card.innerText()), 20000, 'unavailable after source loss');
    fs.rmSync(f.file);
  });

  await r.step('15. signaling server outage: peers keep working; after restart everyone recovers and new users can join', async () => {
    await server.stop();
    await bob.page.getByTestId('signaling-banner').waitFor({ timeout: 20000 });
    await bob.say('sent during outage');
    await carol.waitMessage('sent during outage');
    await server.start();
    await until(async () => (await bob.page.getByTestId('signaling-banner').count()) === 0, 40000, 'signaling reconnected');
    const grace = await mkUser('Grace');
    await grace.join();
    await grace.joined();
    await grace.waitConnected(2, 40000);
    await grace.waitMessage('sent during outage');
  });

  await r.step('16. a room password is enforced; wrong passwords are refused', async () => {
    const owner = await mkUser('Owner');
    await owner.join({ room: 'secret-room', password: 'hunter2' });
    await owner.joined();
    const intruder = await mkUser('Intruder');
    await intruder.join({ room: 'secret-room', password: 'wrong' });
    await intruder.page.getByTestId('join-error').waitFor();
    assert.match(await intruder.page.getByTestId('join-error').innerText(), /password/i);
    await intruder.page.getByTestId('join-password').fill('hunter2');
    await intruder.page.getByTestId('join-submit').click();
    await intruder.joined();
    await owner.waitConnected(1);
  });

  await r.step('17. optional participant approval: admin approves one and declines another', async () => {
    const admin = await mkUser('Admin');
    await admin.join({ room: 'gated', approval: true });
    await admin.joined();
    const ok = await mkUser('Welcome');
    await ok.join({ room: 'gated' });
    await admin.page.getByTestId('approve-join').click({ timeout: 15000 });
    await ok.joined();
    const bad = await mkUser('Nope');
    await bad.join({ room: 'gated' });
    await admin.page.getByTestId('decline-join').click({ timeout: 15000 });
    await bad.page.getByTestId('join-error').waitFor({ timeout: 10000 });
    assert.match(await bad.page.getByTestId('join-error').innerText(), /declined/i);
  });

  await r.step('18. HTTPS origin: downloads stream straight to disk (File System Access) with hash verification', async () => {
    // Stub the save picker with an OPFS file so the streaming DiskSink path runs without a native dialog.
    const stub = () => {
      window.showSaveFilePicker = async (o) => (await navigator.storage.getDirectory()).getFileHandle(o?.suggestedName ?? 'out.bin', { create: true });
    };
    const h1 = await mkUser('HttpsA', HTTPS, { initScript: stub });
    const h2 = await mkUser('HttpsB', HTTPS, { initScript: stub });
    for (const u of [h1, h2]) {
      await u.join({ room: 'https-room' });
      await u.joined();
    }
    assert.equal(await h1.page.evaluate(() => window.isSecureContext), true);
    await h1.waitConnected(1, 30000);
    const f = makeFile(tmp, 'streamed.bin', 40 * 1024 * 1024, 33);
    await h1.post(f.file);
    await h2.card('streamed.bin').waitFor({ timeout: 30000 });
    await h2.card('streamed.bin').getByTestId('download-btn').click();
    await h2.card('streamed.bin').getByText('Downloaded and verified').waitFor({ timeout: 60000 });
    const sha = await h2.page.evaluate(async () => {
      const fh = await (await navigator.storage.getDirectory()).getFileHandle('streamed.bin');
      const file = await fh.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      const d = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
    });
    assert.equal(sha, f.sha256);
  });

  await r.step('19. the same identity opened in a second tab replaces the first instead of corrupting the mesh', async () => {
    const tab2 = await carol.ctx.newPage();
    await tab2.goto(HTTP + '/');
    await tab2.getByTestId('join-name').fill('Carol');
    await tab2.getByTestId('join-submit').click();
    await tab2.getByTestId('chat-title').waitFor({ timeout: 15000 });
    await carol.page.getByTestId('join-error').waitFor({ timeout: 15000 });
    assert.match(await carol.page.getByTestId('join-error').innerText(), /another tab/i);
    await tab2.close();
  });

  await r.step('20. no uncaught page errors in any session', async () => {
    const errs = users.flatMap((u) => u.errors.map((e) => `${u.name}: ${e}`)).filter((e) => !/WebSocket|socket\.io|ERR_CONNECTION|Failed to load resource|net::/i.test(e));
    assert.deepEqual(errs, []);
  });
} finally {
  const ok = r.summary();
  for (const u of users) await u.close();
  await browser.close();
  await server.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

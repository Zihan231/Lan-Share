// Minimal end-to-end harness: real Chrome, real WebRTC, real signaling server.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function lanIp() {
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs ?? []) if (i.family === 'IPv4' && !i.internal && i.address.startsWith('192.168.')) return i.address;
  return '127.0.0.1';
}

export class Server {
  constructor(port, httpsPort, env = {}) {
    this.port = port;
    this.httpsPort = httpsPort;
    this.env = env;
    this.proc = null;
  }
  async start() {
    const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
    this.proc = spawn(process.execPath, [tsx, 'server/src/index.ts'], {
      cwd: root,
      env: { ...process.env, PORT: String(this.port), HTTPS_PORT: String(this.httpsPort), ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.log = '';
    this.proc.stdout.on('data', (d) => (this.log += d));
    this.proc.stderr.on('data', (d) => (this.log += d));
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/healthz`);
        if (r.ok) return;
      } catch {}
      await sleep(150);
    }
    throw new Error('server did not start:\n' + this.log);
  }
  async stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    await new Promise((res) => {
      p.once('exit', res);
      p.kill();
      setTimeout(res, 3000);
    });
  }
}

export async function launch() {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-first-run', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'],
  });
}

export function makeFile(dir, name, size, seed = 1) {
  const file = path.join(dir, name);
  const fd = fs.openSync(file, 'w');
  const block = Buffer.alloc(1024 * 1024);
  const hash = crypto.createHash('sha256');
  let written = 0;
  let x = seed;
  while (written < size) {
    const n = Math.min(block.length, size - written);
    for (let i = 0; i < n; i += 4) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      block.writeUInt32LE(x, Math.min(i, block.length - 4));
    }
    fs.writeSync(fd, block, 0, n);
    hash.update(block.subarray(0, n));
    written += n;
  }
  fs.closeSync(fd);
  return { file, size, sha256: hash.digest('hex') };
}

export const sha256File = (file) =>
  new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });

export async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}${last ? ': ' + last.message : ''}`);
    await sleep(100);
  }
}

export class User {
  constructor(browser, name) {
    this.browser = browser;
    this.name = name;
  }
  async open(base, opts = {}) {
    this.base = base;
    this.ctx = await this.browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true, viewport: opts.viewport ?? { width: 1360, height: 860 } });
    if (opts.initScript) await this.ctx.addInitScript(opts.initScript);
    this.page = await this.ctx.newPage();
    this.errors = [];
    this.page.on('pageerror', (e) => this.errors.push(String(e)));
    this.page.on('console', (m) => m.type() === 'error' && this.errors.push('console: ' + m.text()));
    await this.page.goto(base + '/' + (opts.path ?? ''));
    return this;
  }
  async join({ room, password, approval } = {}) {
    const p = this.page;
    await p.getByTestId('join-name').fill(this.name);
    if (room || password || approval) {
      await p.getByText('Room options').click();
      if (room) await p.getByTestId('join-room').fill(room);
      if (password) await p.getByTestId('join-password').fill(password);
      if (approval) await p.getByRole('switch', { name: 'Require approval' }).click();
    }
    await p.getByTestId('join-submit').click();
    return this;
  }
  async joined() {
    await this.page.getByTestId('chat-title').waitFor({ timeout: 15000 });
    return this;
  }
  peerRows() {
    return this.page.getByTestId('peer-row');
  }
  async connectedPeers() {
    return this.page.locator('[data-testid=peer-row][data-conn=connected]').count();
  }
  async waitConnected(n, ms = 20000) {
    await until(async () => (await this.connectedPeers()) >= n, ms, `${this.name} to have ${n} connected peers`);
  }
  async say(text) {
    await this.page.getByTestId('composer-input').fill(text);
    await this.page.getByTestId('send-btn').click();
  }
  async messages() {
    return this.page.getByTestId('message').evaluateAll((els) => els.map((e) => e.innerText));
  }
  async waitMessage(substr, ms = 15000) {
    await until(async () => (await this.messages()).some((m) => m.includes(substr)), ms, `${this.name} to see "${substr.slice(0, 30)}"`);
  }
  async post(file, caption = '') {
    await this.page.getByTestId('file-input').setInputFiles(file);
    if (caption) await this.page.getByTestId('composer-input').fill(caption);
    await this.page.getByTestId('send-btn').click();
  }
  card(name) {
    return this.page.getByTestId('file-card').filter({ hasText: name }).first();
  }
  async close() {
    await this.ctx?.close().catch(() => {});
  }
}

export function runner(title) {
  const results = [];
  return {
    async step(name, fn) {
      const t0 = Date.now();
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
      } catch (e) {
        results.push({ name, ok: false, err: e });
        console.log(`  ✗ ${name}\n      ${String(e.message ?? e).split('\n').join('\n      ')}`);
      }
    },
    summary() {
      const bad = results.filter((r) => !r.ok);
      console.log(`\n${title}: ${results.length - bad.length}/${results.length} scenarios passed`);
      return bad.length === 0;
    },
  };
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './app.js';
import { loadConfig } from './config.js';
import { lanAddresses } from './net.js';

// Optional settings file (see .env.example). Real environment variables win over the file.
for (const f of [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'), path.resolve('.env')]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* no .env file: use defaults */
  }
}

const cfg = loadConfig();

startServer(cfg)
  .then((srv) => {
    const line = '─'.repeat(64);
    console.log(`\n${line}\n  LANShare signaling server is running (no files are stored here)\n${line}`);
    console.log(`  This computer:   http://localhost:${srv.httpPort}`);
    if (srv.httpsPort) console.log(`                   https://localhost:${srv.httpsPort}`);
    const ips = lanAddresses();
    if (ips.length === 0) console.log('  No LAN address found: connect this computer to the Wi-Fi / Ethernet network.');
    for (const u of srv.urls.http) console.log(`  Share on LAN:    ${u}`);
    for (const u of srv.urls.https) console.log(`  Secure (HTTPS):  ${u}   (${srv.tls === 'self-signed' ? 'self-signed: accept the browser warning once' : 'custom certificate'})`);
    if (cfg.roomPassword) console.log('  Rooms require the configured ROOM_PASSWORD.');
    if (cfg.requireApproval) console.log('  New rooms require admin approval for joiners.');
    console.log(`${line}\n`);
    const stop = () => srv.close().finally(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })
  .catch((err) => {
    console.error('Failed to start LANShare server:', err?.code === 'EADDRINUSE' ? `port already in use (${err.message})` : err);
    process.exit(1);
  });

import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import type { ServerConfig } from './config.js';

export interface TlsMaterial {
  cert: string;
  key: string;
  source: 'provided' | 'self-signed';
}

/**
 * Returns TLS material for the HTTPS listener. Uses TLS_CERT/TLS_KEY (e.g. from mkcert) when
 * provided, otherwise generates (and caches) a self-signed certificate whose SANs cover
 * localhost and every LAN IP of this machine. Browsers will show a one-time warning for it.
 */
export function loadTls(cfg: ServerConfig, ips: string[]): TlsMaterial {
  if (cfg.tlsCertPath && cfg.tlsKeyPath) {
    return { cert: fs.readFileSync(cfg.tlsCertPath, 'utf8'), key: fs.readFileSync(cfg.tlsKeyPath, 'utf8'), source: 'provided' };
  }
  fs.mkdirSync(cfg.certDir, { recursive: true });
  const certFile = path.join(cfg.certDir, 'cert.pem');
  const keyFile = path.join(cfg.certDir, 'key.pem');
  const metaFile = path.join(cfg.certDir, 'meta.json');
  const wanted = JSON.stringify([...ips].sort());
  try {
    if (fs.existsSync(certFile) && fs.existsSync(keyFile) && JSON.parse(fs.readFileSync(metaFile, 'utf8')).ips === wanted) {
      return { cert: fs.readFileSync(certFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8'), source: 'self-signed' };
    }
  } catch {
    /* regenerate */
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'LANShare' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(metaFile, JSON.stringify({ ips: wanted, created: new Date().toISOString() }));
  return { cert: pems.cert, key: pems.private, source: 'self-signed' };
}

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import type { ServerConfig } from './config.js';
import { securityHeaders } from './middleware/security.js';
import { isHostIp, lanAddresses } from './net.js';
import { attachSignaling, type SignalingServer } from './signaling/attach.js';
import { loadTls } from './tls.js';

export interface RunningServer {
  signaling: SignalingServer;
  httpPort: number;
  httpsPort?: number;
  urls: { http: string[]; https: string[] };
  tls?: 'provided' | 'self-signed';
  close(): Promise<void>;
}

const listenSingle = (srv: http.Server | https.Server, port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      srv.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.removeListener('error', onError);
      resolve((srv.address() as { port: number }).port);
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, host);
  });

const listenWithFallback = async (srv: http.Server | https.Server, ports: number[], host: string): Promise<number> => {
  let lastErr: unknown;
  for (const port of ports) {
    try {
      return await listenSingle(srv, port, host);
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    }
  }
  throw lastErr;
};

/**
 * Builds and starts the LAN server: static client files, a tiny info endpoint and the signaling service.
 * There is deliberately no upload, storage or file-relay endpoint.
 */
export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const ips = lanAddresses();
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  let httpsPort: number | undefined;
  const info = () => ({
    name: 'LANShare',
    urls: {
      http: ips.map((ip) => `http://${ip}:${cfg.httpPort}`),
      https: httpsPort ? ips.map((ip) => `https://${ip}:${httpsPort}`) : [],
    },
    requiresRoomPassword: !!cfg.roomPassword,
  });
  app.get('/api/info', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...info(),
      isHost: isHostIp(req.socket.remoteAddress, ips),
    });
  });
  app.get('/healthz', (_req, res) => void res.type('text').send('ok'));

  const hasClient = fs.existsSync(path.join(cfg.clientDir, 'index.html'));
  if (hasClient) {
    app.use(express.static(cfg.clientDir, { index: false, maxAge: '1h', setHeaders: (res, p) => p.endsWith('index.html') && res.setHeader('Cache-Control', 'no-cache') }));
    app.get(/^\/(?!socket\.io|api).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(cfg.clientDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => void res.status(503).type('text').send('Client not built. Run "npm run build" (or "npm run dev" for development).'));
  }

  const httpServer = http.createServer(app);
  const servers: Array<http.Server | https.Server> = [httpServer];
  let httpsServer: https.Server | undefined;
  let tlsSource: 'provided' | 'self-signed' | undefined;
  if (cfg.https) {
    const tls = loadTls(cfg, ips);
    tlsSource = tls.source;
    httpsServer = https.createServer({ cert: tls.cert, key: tls.key }, app);
    servers.push(httpsServer);
  }
  const signaling = attachSignaling(servers, cfg);

  const httpCandidates = cfg.httpPort === 0 ? [0] : cfg.httpPorts && cfg.httpPorts[0] === cfg.httpPort ? cfg.httpPorts : [cfg.httpPort, cfg.httpPort + 1, cfg.httpPort + 2];
  const httpPort = await listenWithFallback(httpServer, httpCandidates, cfg.host);
  cfg.httpPort = httpPort;

  if (httpsServer) {
    const httpsCandidates = cfg.httpsPort === 0 ? [0] : cfg.httpsPorts && cfg.httpsPorts[0] === cfg.httpsPort ? cfg.httpsPorts : [cfg.httpsPort, cfg.httpsPort + 1, cfg.httpsPort + 2];
    httpsPort = await listenWithFallback(httpsServer, httpsCandidates, cfg.host);
  }

  const i = info();
  return {
    signaling,
    httpPort,
    httpsPort,
    urls: i.urls,
    tls: tlsSource,
    async close() {
      await signaling.close();
      for (const s of servers) {
        s.closeAllConnections?.();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}

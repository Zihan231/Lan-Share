import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : d;
};
const portList = (v: string | undefined, defaults: number[]): number[] => {
  if (!v) return defaults;
  const parsed = v
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  if (parsed.length === 0) return defaults;
  if (parsed.length === 1) {
    const p = parsed[0];
    return [p, p + 1, p + 2].filter((n) => n < 65536);
  }
  return parsed;
};
const flag = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

export const DEFAULT_HTTP_PORTS = [7420, 7421, 7422];
export const DEFAULT_HTTPS_PORTS = [7443, 7444, 7445];

export interface ServerConfig {
  host: string;
  httpPort: number;
  httpPorts?: number[];
  httpsPort: number;
  httpsPorts?: number[];
  https: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  certDir: string;
  clientDir: string;
  /** If set, every room created on this server requires this password. */
  roomPassword?: string;
  /** If true, rooms created on this server require admin approval for new participants. */
  requireApproval: boolean;
  approvalTimeoutMs: number;
  maxPeersPerRoom: number;
  maxRooms: number;
  /** Max join attempts per IP per minute (slows password guessing). */
  joinsPerMinute: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const httpPorts = portList(env.PORT, DEFAULT_HTTP_PORTS);
  const httpsPorts = portList(env.HTTPS_PORT, DEFAULT_HTTPS_PORTS);
  return {
    host: env.HOST || '0.0.0.0',
    httpPort: httpPorts[0],
    httpPorts,
    httpsPort: httpsPorts[0],
    httpsPorts,
    https: flag(env.HTTPS, true),
    tlsCertPath: env.TLS_CERT || undefined,
    tlsKeyPath: env.TLS_KEY || undefined,
    certDir: env.CERT_DIR || path.resolve(here, '../.certs'),
    clientDir: env.CLIENT_DIR || path.resolve(here, '../../client/dist'),
    roomPassword: env.ROOM_PASSWORD || undefined,
    requireApproval: flag(env.REQUIRE_APPROVAL, false),
    approvalTimeoutMs: 120_000,
    maxPeersPerRoom: int(env.MAX_PEERS_PER_ROOM, 50),
    maxRooms: int(env.MAX_ROOMS, 100),
    joinsPerMinute: int(env.JOINS_PER_MINUTE, 30),
  };
}

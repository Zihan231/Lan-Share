import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : d;
};
const flag = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

export interface ServerConfig {
  host: string;
  httpPort: number;
  httpsPort: number;
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
  return {
    host: env.HOST || '0.0.0.0',
    httpPort: int(env.PORT, 3000),
    httpsPort: int(env.HTTPS_PORT, 3443),
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

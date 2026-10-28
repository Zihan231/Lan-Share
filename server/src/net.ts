import os from 'node:os';

/** Private IPv4 addresses of this machine, most likely LAN address first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : ip.startsWith('169.254.') ? 4 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** True when the remote socket IP belongs to this host machine (loopback or one of its own LAN IPs). */
export function isHostIp(ip: string | undefined, hostIps = lanAddresses()): boolean {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/i, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  return hostIps.includes(clean);
}

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

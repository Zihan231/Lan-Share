export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export const formatSpeed = (bps: number) => (bps > 0 ? `${formatBytes(bps)}/s` : '—');

export function formatEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  if (sec < 1) return '<1s';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = Array.from(parts[0])[0] ?? '?';
  const b = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (a + b).toUpperCase();
}

function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Avatar background (white initials on top, so mid-dark in both themes). */
export function colorFor(id: string): string {
  return `hsl(${hueOf(id)} 55% 40%)`;
}

/** Sender-name text colour; lightness follows the theme (--name-l) so contrast holds in light and dark. */
export function nameColorFor(id: string): string {
  return `hsl(${hueOf(id)} 65% var(--name-l))`;
}

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'doc' | 'sheet' | 'slides' | 'code' | 'other';

export function fileKind(name: string, mime: string): FileKind {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext)) return 'archive';
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'slides';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'sh', 'json', 'yml', 'yaml', 'html', 'css', 'sql', 'xml'].includes(ext)) return 'code';
  return 'other';
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  pdf: 'PDFs',
  archive: 'Archives',
  doc: 'Documents',
  sheet: 'Spreadsheets',
  slides: 'Presentations',
  code: 'Source code',
  other: 'Other',
};

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMime(name: string, given: string): string {
  if (given && /^[\w.+-]+\/[\w.+-]+$/.test(given)) return given.slice(0, 127);
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

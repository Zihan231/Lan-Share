import { Archive, File as FileGeneric, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from 'lucide-react';
import { fileKind, type FileKind } from '../../utils/format';

const ICONS: Record<FileKind, { Icon: typeof FileText; cls: string }> = {
  image: { Icon: FileImage, cls: 'bg-pink-500/15 text-pink-600 dark:text-pink-300' },
  video: { Icon: FileVideo, cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-300' },
  audio: { Icon: FileAudio, cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-300' },
  pdf: { Icon: FileText, cls: 'bg-red-500/15 text-red-600 dark:text-red-300' },
  archive: { Icon: Archive, cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  doc: { Icon: FileText, cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-300' },
  sheet: { Icon: FileSpreadsheet, cls: 'bg-green-500/15 text-green-700 dark:text-green-300' },
  slides: { Icon: Presentation, cls: 'bg-orange-500/15 text-orange-700 dark:text-orange-300' },
  code: { Icon: FileCode, cls: 'bg-slate-500/15 text-slate-700 dark:text-slate-300' },
  other: { Icon: FileGeneric, cls: 'bg-slate-500/15 text-slate-600 dark:text-slate-300' },
};

export function FileIcon({ name, mime, size = 44 }: { name: string; mime: string; size?: number }) {
  const { Icon, cls } = ICONS[fileKind(name, mime)];
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-xl ${cls}`} style={{ width: size, height: size }}>
      <Icon size={size * 0.5} aria-hidden />
    </span>
  );
}

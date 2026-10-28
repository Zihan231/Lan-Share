// File System Access API (Chromium, secure contexts only) — not part of lib.dom in all TS versions.
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: FilePickerAcceptType[];
}
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}
interface FileSystemFileHandle {
  requestPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<'granted' | 'denied' | 'prompt'>;
  queryPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<'granted' | 'denied' | 'prompt'>;
}
interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

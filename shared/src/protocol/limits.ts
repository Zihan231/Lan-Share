/** Hard protocol limits. Receivers enforce these regardless of what a peer claims. */
export const LIMITS = {
  nameMax: 32,
  roomIdMax: 48,
  textMax: 8000,
  filesPerPost: 20,
  fileNameMax: 255,
  mimeMax: 127,
  thumbMax: 48_000,
  /** Absolute upper bound a receiver will ever accept for one file (settings can lower it). */
  fileSizeHardMax: 1024 ** 4, // 1 TiB
  chunkMin: 4 * 1024,
  /** Largest chunk payload. Payload + 4-byte frame header must stay under the 256 KiB SCTP message limit of Chromium/Safari. */
  chunkMax: 256 * 1024 - 16,
  recordMaxBytes: 64 * 1024,
  syncIdsMax: 20_000,
  syncBatchMax: 100,
  sdpMax: 20_000,
} as const;

export const DEFAULT_ROOM_ID = 'lanshare';
export const DEFAULT_ROOM_NAME = 'LANShare Room';
export const PROTOCOL_VERSION = 1;

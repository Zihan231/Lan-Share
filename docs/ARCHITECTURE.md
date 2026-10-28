# LANShare architecture

## Components

```
 Browser A ◄════ WebRTC DataChannels (DTLS) ════► Browser B
     │  ▲                                              │  ▲
     │  └──────────── signaling (Socket.IO) ───────────┘  │
     ▼                                                    ▼
          Node server: static files + signaling + presence
          (no files, no messages, no database)
```

| Piece | Responsibility |
|---|---|
| `server/` | Serves `client/dist`; Socket.IO signaling: authenticated join, room password/approval gate, presence, relaying SDP/ICE between members of one room, rate limits. Optional self-signed HTTPS. |
| `shared/` | The wire protocol used by both sides: IDs, Ed25519 signing, record format + validation, peer message types, limits. |
| `client/services/webrtc` | `PeerSession` = one RTCPeerConnection + the `ctl` channel + handshake + heartbeat. `Mesh` = one session per peer, deterministic initiator, reconnect with back-off. |
| `client/services/sync` | `RecordStore`: the room's log of signed records; dedup, tombstones, deterministic order, diffing for sync. |
| `client/services/transfers` | `TransferManager` (send/receive protocol), `Sink`s (disk or IndexedDB), `FileRegistry` (what this device can serve), streaming SHA-256 (Web Worker). |
| `client/services/app/Engine.ts` | Glue + UI state (Zustand). The UI only calls Engine methods. |

## Connection establishment

1. Socket.IO connects; the server sends a random `challenge`.
2. Client `join`s with `{roomId, peerId, publicKey, name, sig(challenge)}`; the server checks `peerId == hash(publicKey)` and the signature (proof of key possession), then the password / admin approval, and replies with the member list.
3. For each pair, the peer with the **smaller peer ID** is the initiator and creates the offer + the `ctl` DataChannel; the other answers. There is no glare. ICE is trickled via the server. **No STUN/TURN** servers are configured; host candidates are enough on a LAN.
4. On `ctl` open both sides send `hello {peerId, key, nonce}` and then `auth {sig}` where the signature covers the other side's nonce **and both DTLS fingerprints** taken from the SDPs. A peer is "connected" only after verifying the other's `auth`. Nothing but `hello`/`auth` is processed before that.
5. Heartbeat: ping every 5 s; no traffic for 16 s ⇒ session closed. Failures reconnect with back-off (0.5 s … 15 s). When the signaling server returns, clients re-join automatically and call `retryAll`. Existing sessions are **not** torn down by a signaling outage.

## Records and synchronisation

Everything shared is a **signed record** `{id, roomId, kind: text|file|delete, authorId, authorKey, authorName, ts, …, sig}`:

- `id` is a random 128-bit value, so duplicates (reconnect, two relays) collapse; order is `(ts, id)`, identical on every peer.
- A record is only accepted if `peerId = hash(authorKey)`, the signature verifies, sizes/types are valid, and for file records each file's `uploaderId` equals the author.
- **Live delivery:** broadcast over every `ctl`; the receiver acks (`ack`), which drives the ✓ / ✓✓ delivery indicator ("delivered to N peers").
- **History sync on connect:** each side sends `sync-have {ids}` (ids it holds plus ids it knows are deleted); the other replies with the records missing on that side, in size-limited batches. Any peer can relay history of any author because records are self-authenticating.
- **Deletion:** a `delete` record (tombstone) targets a record id. It is honoured if signed by the target's author or a known room admin. Tombstones are kept, and deleted ids are advertised, so a stale peer cannot resurrect content. "Delete for me" is a local hidden-set only. "Clear local history" sets a local `clearedBefore` timestamp so re-synced older records are ignored.

## File transfer

Metadata (`name, mime, size, sha256, uploaderId, optional JPEG thumbnail`) rides inside the signed file record. Bytes never move until a user clicks Download.

```
Downloader                                   Source (uploader or replica holder)
  ctl: file-request {transferId, fileId} ─────────────►
                                                       checks: known file, rate limit, per-peer cap,
                                                       local copy exists & size matches; may queue
  ◄──────────── opens DataChannel "xfer:<transferId>"
  ◄──────────── {start: size, chunkSize, chunks, window}
  ◄──────────── binary frames [u32 seq][payload] …   (backpressure: bufferedAmount high/low water)
  ack {bytes persisted} ──────────────────────────────►  (sender never exceeds `window` unacked bytes)
  ◄──────────── {end}
  verify total size, SHA-256 == signed metadata → commit sink → final ack
```

- The receiver validates `start` against the signed metadata, enforces sequence numbers and exact chunk geometry, and aborts on any violation.
- **Sinks:** `DiskSink` (File System Access: streamed to the user's file; secure context + Chromium) or `StoreSink` (IndexedDB segments of ~4 MiB, then handed to the browser's download manager). The whole file is never held in RAM by the app.
- **Concurrency:** configurable simultaneous uploads (extra requests queue and the requester is told) and downloads. Uploads per peer and request rate are capped.
- **Failure:** channel close, stall (30 s), integrity mismatch or peer loss ⇒ the next advertised holder is tried from byte 0; otherwise the transfer fails with a message. Not resumable.

## Availability and replication

- Each device announces the file ids it can serve (`files-have`), full on connect and incrementally after. A holder is either the **original `File`** (valid for the page's lifetime, or re-authorised via a stored `FileSystemFileHandle`) or a **replica**.
- A replica exists only if the user ticked *Keep sharing this file* for that download **and** the download completed and passed the SHA-256 check. It is stored as segments in IndexedDB (persistent storage is requested), counted against a configurable cache limit, and listed under Settings with *Stop sharing*.
- Peers that disconnect are dropped from availability immediately. No holder ⇒ the card is marked unavailable and Download is disabled.
- Replicas never touch the original file on the uploader's disk.

## Security notes

| Threat | Mitigation |
|---|---|
| Claiming someone else's peer ID | ID = hash(public key); signed join challenge (server) and key + DTLS-bound handshake (peers) |
| Forged / altered history | Per-record Ed25519 signatures, validated before storing or relaying |
| Rogue signaling server splicing sessions | Handshake signatures bind both DTLS fingerprints; key substitution changes the peer ID/safety code |
| XSS via messages/names/file names | React text nodes only; names and file names sanitised; thumbnails restricted to `data:image/jpeg;base64`; strict CSP (`script-src 'self'`) |
| Malformed metadata/chunks, size lies | Strict validators, sequence and size checks, SHA-256, size limits |
| Unwanted downloads / disk abuse | Downloads only on click; per-peer request caps; storage limits |
| Request / signaling floods | Token buckets per peer, per socket and per IP; payload size caps |
| Eavesdropping on the LAN | DTLS on all DataChannels; use HTTPS for the page itself where the LAN is hostile |
| Password guessing | scrypt-hashed in memory, constant-time compare, per-IP join limiter |

Limits: the password/approval gate lives on the host; a malicious host can disrupt service or serve altered JavaScript (mitigate with a trusted HTTPS certificate and by comparing safety codes); keys live in IndexedDB and are readable by anyone with access to the browser profile.

## Why pure-JS crypto

`crypto.subtle` does not exist on plain-HTTP origins like `http://192.168.1.10:3000`. Using audited pure-JS Ed25519/SHA-256 (`@noble/*`) keeps one code path that works on HTTP and HTTPS and in the Web Worker that hashes large files. WebRTC's own DTLS encryption is native and unaffected.

## Storage layout (IndexedDB `lanshare[-profile]`)

`kv` (identity, settings, name, trusted peers, hidden ids, cleared-before, known admins) · `records` (signed log, indexed by room) · `replicas` (metadata of complete copies) · `segments` (`[fileId, index] → Blob`) · `handles` (File System Access handles).

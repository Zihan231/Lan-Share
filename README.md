# LANShare

Offline, WhatsApp-style group chat and **peer-to-peer file sharing** for everyone on the same Wi-Fi / LAN. Open a web page, pick a name, chat, drop files into the group, and download what others share with one click. No internet, no accounts, no app to install.

- Browser UI only (React + TypeScript + Tailwind). Messages and files travel **directly between browsers** over WebRTC DataChannels (DTLS-encrypted).
- A tiny Node.js server serves the page and helps browsers find each other (WebRTC signaling). It **never relays or stores messages or files**.
- Files stay on the sender's device until somebody clicks **Download**. Optionally, downloaders can *keep sharing* a verified copy so the file survives the original uploader going offline.

> **Honest scope.** Browsers cannot discover each other on a LAN or elect a replacement server by themselves, so one computer runs the small LANShare server. If it stops, existing peer connections keep working, but nobody new can join until it is back (see [Limitations](#known-limitations)).

---

## Quick start

Requirements: **Node.js 22+** (20.12+ works) on one computer that will act as the host. Clients need only a modern browser.

```bash
npm install
npm run build        # builds the web app into client/dist
npm start            # starts the server (HTTP :3000 and HTTPS :3443)
```

The server prints the addresses to share, for example:

```
Share on LAN:    http://192.168.1.100:3000
Secure (HTTPS):  https://192.168.1.100:3443   (self-signed: accept the browser warning once)
```

On every other device connected to the **same Wi-Fi/router**, open that address, enter a display name, and join **LANShare Room**.

### Development mode

```bash
npm run dev          # signaling server on :3000 + Vite dev server with hot reload on :5173
```

Open `http://localhost:5173`. To run several identities in one browser, add `?profile=alice`, `?profile=bob`, … to the URL (each profile has its own identity and storage).

### Finding the server's LAN IP

The server prints it on startup. Manually:

| OS | Command |
|----|---------|
| Windows | `ipconfig` → "IPv4 Address" of your Wi-Fi/Ethernet adapter |
| macOS | `ipconfig getifaddr en0` (Wi-Fi) |
| Linux | `hostname -I` or `ip -4 addr` |

LAN addresses typically look like `192.168.x.x`, `10.x.x.x` or `172.16–31.x.x`. The in-app sidebar also shows a copyable invite address.

---

## Making devices actually reach each other (read this if joining fails)

1. **Host firewall.** The host must accept inbound TCP on the LANShare ports. Windows (admin PowerShell):
   ```powershell
   netsh advfirewall firewall add rule name="LANShare" dir=in action=allow protocol=TCP localport=3000,3443 profile=private
   ```
   Make sure the Wi-Fi network is marked **Private**, not Public. macOS: allow incoming connections for Node when prompted. Linux: `sudo ufw allow 3000,3443/tcp`.
2. **Router "AP / client isolation".** Many guest networks and some home routers isolate wireless clients from each other. Then devices can load nothing from the host *and* WebRTC cannot connect. Disable *AP isolation / client isolation / guest-network isolation*, or use a normal (non-guest) SSID. This is the #1 cause of "I can open the page on the host but not elsewhere".
3. **Peer-to-peer (WebRTC) traffic is browser-to-browser over UDP**, on random ports, not through the server. Personal firewalls/VPNs/security suites on *client* devices can block it. Turn off VPNs that route local traffic; allow the browser through the firewall on private networks.
4. **mDNS / multicast.** Modern browsers hide local IPs behind `*.local` (mDNS) names in WebRTC candidates. Networks that block multicast can break this. Symptom: the page loads and people appear in the list, but their status stays "Connecting…" / "Cannot connect directly". Fixes: allow multicast on the router (often "IGMP snooping"/"multicast isolation"), or on Chrome/Edge set `chrome://flags/#enable-webrtc-hide-local-ips-with-mdns` to *Disabled*, or Firefox `media.peerconnection.ice.obfuscate_host_addresses` to `false`.
5. No internet is needed anywhere: the app uses no CDN, fonts, analytics, STUN or TURN. It runs fully offline.

The app shows clear states for this: signaling reachable but peer **"Cannot connect directly"** means the network is blocking peer-to-peer traffic (points 2–4).

---

## HTTP vs HTTPS (secure contexts)

Everything works over plain `http://<lan-ip>:3000`. Identity/signatures use a pure-JS library specifically so that **no WebCrypto is required**. But browsers only expose some APIs on *secure contexts* (HTTPS or `localhost`):

| Capability | `http://192.168.x.x` | `https://…` / `localhost` |
|---|---|---|
| Chat, presence, file sharing, hashing, replication | ✅ | ✅ |
| Download streamed **straight to disk** (File System Access, Chromium) | ❌ — staged in browser storage, then saved | ✅ |
| Re-share files after a refresh via remembered file handles (Chromium) | ❌ | ✅ |

So on HTTP, a download is held in IndexedDB until complete and then handed to the browser. This works, but needs free browser storage ≈ file size and very large files (many GB) may hit browser quota. Prefer the HTTPS address for big files.

**HTTPS options**

- *Default (zero setup):* the server generates a self-signed certificate (cached in `server/.certs/`, regenerated if the host's IPs change). Each device must click through the browser warning once ("Advanced → Proceed").
- *Trusted, no warnings:* use [mkcert](https://github.com/FiloSottile/mkcert):
  ```bash
  mkcert -install                                   # on the host
  mkcert -cert-file certs/lanshare.pem -key-file certs/lanshare-key.pem 192.168.1.100 localhost
  # then in .env:  TLS_CERT=./certs/lanshare.pem  TLS_KEY=./certs/lanshare-key.pem
  ```
  Other devices must also trust mkcert's root CA (`mkcert -CAROOT` → install `rootCA.pem` on each device), otherwise they still see a warning. For a mixed-device LAN, accepting the self-signed warning once is usually simpler.
- Disable HTTPS entirely with `HTTPS=0`.

---

## Using LANShare

- **Join:** enter a display name. *Room options* lets you choose a room ID, set a **password** (when you create the room), or require **admin approval** for newcomers (when you create the room).
- **Chat:** Enter sends, Shift+Enter adds a line (on touch devices Enter adds a line). Emoji picker, copy text, delete for me / for everyone.
- **Share files:** click the paperclip, drag & drop anywhere on the chat, or paste an image. Add an optional caption. A file card appears for everyone; nothing is downloaded automatically.
- **Download:** click **Download** on a card. Progress, speed and ETA are shown; **Cancel** any time. The file is verified against its SHA-256 before it is saved.
- **Keep sharing this file** (opt-in, per download): stores a verified copy in your browser so you can serve it to others when the original uploader is offline. Manage under *Settings → Sharing & storage*.
- **Shared files panel:** search, filter by type, sort, details, find identical files by checksum.
- **People:** connection state per peer, admin crown, trusted/unverified badge. Open a person to see their **safety code**.

### Settings (per device)

Chunk size, simultaneous uploads/downloads, max file size, in-flight window, cache limit, thumbnails, theme, persistent-storage request, clear history / cached files / all data.

### Server settings (`.env`, see `.env.example`)

`PORT`, `HTTPS_PORT`, `HTTPS`, `HOST`, `TLS_CERT`/`TLS_KEY`, `ROOM_PASSWORD` (forced password on every new room), `REQUIRE_APPROVAL`, `MAX_PEERS_PER_ROOM`, `MAX_ROOMS`, `JOINS_PER_MINUTE`.

---

## Production deployment on a LAN

```bash
npm ci
npm run build
HTTPS=1 PORT=3000 npm start          # or copy .env.example to .env and edit
```

Keep it running with your process manager of choice (`pm2 start "npm start" --name lanshare`, a systemd unit, a Windows scheduled task, …). The server holds **no persistent state**: rooms, passwords and presence live in memory, and user data lives in each user's browser.

---

## Project layout

```
lanshare/
├── client/            React + Vite + Tailwind app
│   └── src/
│       ├── components/{chat,files,peers,layout,common}
│       ├── pages/  stores/  hooks/  utils/  workers/
│       └── services/
│           ├── app/        Engine: wires everything, owns the UI state
│           ├── signaling/  Socket.IO client (join, reconnect, re-join)
│           ├── webrtc/     PeerSession (handshake, heartbeat), Mesh (full-mesh, reconnect), framing
│           ├── sync/       RecordStore (dedup, tombstones, deterministic order, diffing)
│           ├── transfers/  TransferManager, sinks, FileRegistry, hashing
│           └── storage/    IndexedDB (records, replicas, handles, settings), identity
├── server/            Express + Socket.IO signaling server (+ static hosting, TLS)
├── shared/            Wire protocol: types, limits, crypto, validation, signing
├── tests/             Vitest unit/integration tests + Playwright end-to-end (real Chrome)
└── docs/ARCHITECTURE.md
```

More detail on the protocols, security model and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Testing

```bash
npm test             # 98 unit + integration tests (Vitest)
npm run typecheck    # strict TypeScript for shared, server and client
npm run build && npm run test:e2e    # real-browser end-to-end (needs Google Chrome installed)
```

- **Unit:** metadata validation, record signing/impersonation, sanitising, SHA-256, message fragmentation, deduplication, deterministic merge, tombstones, history sync convergence, the whole file-transfer protocol (integrity, back-pressure, queueing, cancel, failover, malicious senders).
- **Integration:** the real signaling server over Socket.IO (presence, relay, password, approval, impersonation, replay, cross-room isolation); the real `PeerSession`/`Mesh` code over a fake RTCPeerConnection (handshake, key/DTLS-fingerprint binding, heartbeat, reconnect, signaling outage, replaced sessions).
- **End-to-end** (`tests/e2e/run.mjs`): separate Chrome profiles over the real LAN IP (plain HTTP, i.e. *not* a secure context) plus an HTTPS profile: join/presence, messaging + delivery ticks, 5-user mesh, late-joiner sync, post → on-demand download with byte-identical verification, simultaneous downloads, a large file (default 200 MB; `BIG_MB=…`), cancel, opt-in replica surviving uploader exit **and** a refresh, "unavailable" state, tab close, refresh with history restore and no duplicates, XSS payload rendered inert, interrupted transfer, signaling server stop/restart, password and approval flows, streaming-to-disk download over HTTPS, second-tab takeover.

Not covered by automation: Firefox and Safari, phones/tablets on real Wi-Fi, restoring file handles after a refresh (needs the native file picker), networks with client isolation.

---

## Known limitations

These are properties of browsers and LANs, not bugs:

- **A host computer is required.** No ordinary browser can act as a permanent server, discover arbitrary devices, or elect a replacement. If the host stops: existing peer connections keep working and the UI says so, but new people can't join and reconnects after a drop need the server. Rooms/passwords are forgotten when the server restarts (the first person back in re-creates the room); message history survives in browsers.
- **History exists only where a peer kept it.** A new user gets whatever any online peer holds (the latest ~5000 records are sent per sync). If everyone who has it is offline, it is gone.
- **Files exist only where someone holds them.** If the uploader is offline and nobody opted in to keep a copy, the card says *"File currently unavailable — no online peer has a copy."* and Download is disabled. After a refresh, an uploader no longer has the original `File` object unless it was picked through the File System Access API and the user re-grants access (*Shared files → Grant access and resume sharing*, Chromium on HTTPS/localhost only).
- **Transfers are not resumable.** An interrupted download restarts from byte 0 (possibly from another holder). Nothing is advertised as resumable.
- **One source per download**, not multi-peer swarming. Failover tries the next holder.
- **Large downloads without File System Access** (Firefox, Safari, any browser on plain HTTP) are staged in IndexedDB first; subject to browser quota and memory behaviour of the download manager.
- **Throughput** is bounded by the browser's SCTP implementation and your Wi-Fi. On the development PC (headless Chrome, loopback) the app moved ~4 MB/s, and a bare `RTCDataChannel` benchmark on the same machine gave ~2.5 MB/s, so it is not an app bottleneck; real networks will differ.
- **Clocks.** Messages are ordered by the sender's timestamp; skewed device clocks can reorder them slightly (order is still identical for everyone).
- **Browsers tested:** Chrome on Windows. Firefox/Safari/mobile are expected to work for chat and transfers (standard APIs only) but were not run.
- **Two tabs, one identity:** an identity belongs to a browser profile; opening a second tab takes over the session. Use `?profile=name` for more identities.

## Security model (summary)

A shared LAN is not a trusted network. LANShare therefore treats every peer as untrusted by default:

- **Identity = key, not name.** Each browser holds an Ed25519 key; the peer ID is a hash of the public key. The signaling server verifies a signed challenge before it lets anyone claim an ID, and peers verify each other again over the DataChannel with signatures bound to both DTLS fingerprints (a rogue signaling server cannot splice sessions).
- **Messages and file posts are individually signed**, so history relayed by any peer cannot be forged or altered. Deletions are signed tombstones honoured only from the author or the room admin.
- **Everything received is validated** (size, types, sequence, hash) before use; text is rendered as plain text (never HTML); file names are sanitised; nothing is downloaded or executed automatically; per-peer and per-IP rate limits apply.
- **File integrity:** each file's SHA-256 is signed by the uploader; receivers verify while streaming and discard on mismatch.
- **Limits you should know:** the room password and approval gate are enforced by the host server, so anyone who can run a server on the LAN can run their own rooms; display names are not identities (compare the safety codes); an attacker with access to a user's browser profile can use their key; on a hostile LAN a malicious *host* could refuse service or serve a modified web app (use HTTPS with a certificate you trust and compare safety codes for sensitive use).

## Future options (not implemented)

- **Alternative signaling hosts:** the signaling server is small and stateless; clients could accept a list of fallback server URLs, or any member could run the Node server and share its address.
- **Manual WebRTC pairing** (offer/answer exchanged by QR code or copy-paste) would allow joining with *no* server at all for tiny groups.
- Resumable and multi-source (swarm) transfers; file handle restore for more browsers; Web Share Target / PWA install.

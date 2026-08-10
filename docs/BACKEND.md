# Backend contract (`PrintModule`)

What the cloud side must implement for this agent. Lives in the API repo, not here.

## Data model

```prisma
model PrintDevice {
  id         String    @id @default(uuid())
  tenantId   String
  branchId   String
  name       String                          // "Kasa PC", set by the owner
  tokenHash  String    @unique               // sha256 of the durable device token
  status     String    @default("ACTIVE")    // ACTIVE | REVOKED
  lastSeenAt DateTime? @db.Timestamptz
  appVersion String?
  createdAt  DateTime  @default(now()) @db.Timestamptz
  @@index([tenantId, branchId])
}

model PairingCode {
  id        String    @id @default(uuid())
  tenantId  String
  branchId  String
  code      String    @unique                // 6–8 chars, A–Z0–9, no I/O/0/1
  expiresAt DateTime  @db.Timestamptz        // now + 15 min
  usedAt    DateTime? @db.Timestamptz
}
```

Store only the **hash** of the device token; the plaintext exists once, in the pairing
response. Revoking = `status = REVOKED` + close the socket.

## HTTP

### `POST /agent/pair`

```jsonc
// request
{ "code": "A7K2QP", "deviceInfo": { "hostname": "kasa-pc", "platform": "win32 10.0.22631", "arch": "x64", "appVersion": "0.1.0" } }

// 200
{ "deviceToken": "<opaque, 32+ bytes>", "deviceId": "…", "tenantId": "…", "branchId": "…", "tenantName": "Demo Kafe", "branchName": "Merkez" }
```

Status codes the agent already maps to Turkish messages:

| Code | Meaning shown to the user |
| --- | --- |
| 400 / 404 | Kod geçersiz |
| 410 | Kodun süresi doldu (15 dk) |
| 409 | Kod zaten kullanılmış |
| 429 | Çok fazla deneme |

Single-use: set `usedAt` in the same transaction that creates the `PrintDevice`.
Rate-limit by IP **and** by tenant.

### `POST /agent/heartbeat`

`Authorization: Bearer <deviceToken>`, body `{ "appVersion": "0.1.0" }` → update
`lastSeenAt` / `appVersion`. Sent every 5 minutes. Non-critical — the WS is the real
liveness signal.

### `GET /agent/latest?os=win|mac`

`{ "version": "0.1.0", "url": "https://…", "sha256": "…" }` — see
[DOWNLOAD-PAGE.md](DOWNLOAD-PAGE.md).

## WebSocket — `wss://api.ariadisyon.com/agent`

Handshake carries `Authorization: Bearer <deviceToken>`. Reject with **401/403** if the
token is unknown or the device is `REVOKED` — the agent then clears its pairing and
stops retrying (it does *not* hammer the gateway). On accept, join **only** the room for
that device's `tenantId:branchId`.

Server → agent:

```ts
{ type: 'job', payload: PrintJob }
{ type: 'revoked', reason?: string }   // sent on revoke, then close
```

Agent → server:

```ts
{ type: 'hello',   payload: { hostname, platform, arch, appVersion, queued } }
{ type: 'job.ack', payload: { jobId, status: 'printed' | 'failed', error?, attempts } }
```

`PrintJob`:

```ts
{
  jobId: string;                     // idempotency key — the agent dedupes on this
  station: 'BAR' | 'KITCHEN';
  copies: number;
  escpos?: string;                   // base64 pre-rendered bytes (preferred)
  content?: TicketModel;             // structured fallback, rendered by the agent
  codepage?: string;                 // e.g. "CP857"; overrides the printer's setting
}
```

Send **one** of `escpos` / `content`. With `escpos`, the agent still prepends
`ESC @` + `ESC t <page>` from the printer's own config, so one payload prints correctly
on printers configured with different code pages.

### Dispatch and acks

- Keep the existing BullMQ queue as the source of truth. Dispatch to the connected
  device; mark the job `ACKED` on `job.ack.status === 'printed'`.
- No ack within N seconds (device offline / printer down) → job stays pending; resend on
  the next `hello`. Redelivery is safe: the agent dedupes by `jobId` for 24h and re-acks.
- `status: 'failed'` means the agent gave up after 20 attempts — surface it on the
  cashier screen ("bar yazıcısı çevrimdışı").
- Per-station ordering is preserved by the agent; dispatch in order per station.

### Panel actions

- **Yazıcı ajanı ekle** → create a `PairingCode` (15 min TTL) and show it.
- **Cihazı kaldır** → `status = REVOKED`, send `{ type: 'revoked' }`, close the socket.
- Device list shows `name`, `lastSeenAt`, `appVersion`, live connection state.

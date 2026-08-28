# GateKeep

> **Zero-Knowledge Ephemeral Content Sharing Engine** with cryptographic access gates, rate limiting, HMAC-signed webhooks, and compound-indexed analytics.

---

## Key Architecture & Technical Highlights

* **Zero-Knowledge AES-256-GCM Note Encryption:** Symmetric client/server encryption using `scrypt` key derivation with random 16-byte salt, 12-byte IV, and 128-bit authentication tag. Plaintext is never stored in the database.
* **Bijective Base62 Short Links:** Custom 62-character bijective encoding algorithm generating high-entropy 7-character URL-safe slugs ($62^7 \approx 3.52$ trillion combinations).
* **Sequential 5-Gate Access Engine:** Public resolution pipeline ordered from cheapest $O(1)$ checks (existence, boolean burn, lazy expiration) to CPU-heavy cryptographic verification (`argon2id`) and atomic SQL increment.
* **Atomic Burn-on-Read Concurrency:** Row-level locking in PostgreSQL with a single `UPDATE ... SET reads_count = reads_count + 1, is_burned = CASE ...` statement, eliminating read-modify-write race conditions.
* **B-Tree Compound Indexing:** Composite index `(link_id, accessed_at)` on visitor logs enabling $O(\log N)$ point lookups with pre-sorted reverse-chronological scans, bypassing in-memory database sorting.
* **HMAC-SHA256 Outbound Webhooks:** Distributed event notification system (`link.accessed`, `link.burned`) with cryptographically signed payloads (`X-GateKeep-Signature-256`) and exponential backoff delivery.
* **Tiered Sliding-Window Rate Limiting:** In-memory request throttling with IETF headers on auth, resolution, and CRUD routes to prevent credential stuffing and denial-of-service.
* **Multi-Stage Docker Packaging:** Alpine-based multi-stage containerization isolating build tools from the production runtime image (~120MB).

---

## System Architecture & Request Pipeline

```
  Public Internet (Clients / Browsers / Bots)
                      │
                      ▼
             ┌─────────────────┐
             │ Helmet Security │ (HSTS, CSP, X-Frame-Options, NoSniff)
             └────────┬────────┘
                      ▼
             ┌─────────────────┐
             │  CORS & Cookies │ (httpOnly, SameSite=Strict, Secure)
             └────────┬────────┘
                      ▼
             ┌─────────────────┐
             │  Rate Limiting  │ (Sliding Window per IP)
             └────────┬────────┘
                      ▼
       ┌──────────────┴──────────────┐
       │                             │
       ▼                             ▼
┌──────────────┐             ┌──────────────┐
│ /auth, /notes│             │  GET /:slug  │ (Public Resolve)
│ /links, /wh  │             │  POST /:slug │
└──────┬───────┘             └──────┬───────┘
       │ [JWT Auth]                 │ [5-Gate Pipeline]
       ▼                            ▼
┌──────────────┐             ┌──────────────┐
│  Controller  │             │ 1. Exists?   │
│      &       │             │ 2. Burned?   │
│   Services   │             │ 3. Expired?  │
└──────┬───────┘             │ 4. Pass?     │
       │                     │ 5. Atomic ++ │
       │                     └──────┬───────┘
       │                            │
       └──────────────┬─────────────┘
                      ▼
       ┌─────────────────────────────┐
       │   PostgreSQL (Drizzle ORM)  │
       │   + Outbound HMAC Webhooks  │
       └─────────────────────────────┘
```

---

## Quickstart & Deployment

### 1. Prerequisites
* Node.js >= 20
* Docker & Docker Compose

### 2. Environment Configuration
```bash
cp .env.example .env
```

### 3. Local Development (with Docker Postgres)
```bash
# Start PostgreSQL container on port 5433
docker compose up -d postgres

# Push Drizzle schema to DB
npm run db:push

# Start development server with live reload
npm run dev
```

### 4. Running Integration Tests
```bash
npm run test
```

### 5. Full Containerized Production Run
```bash
docker compose up --build
```

---

## API Reference

### Authentication (`/auth`)
* `POST /auth/signup` — Register new user account.
* `POST /auth/login` — Authenticate and receive `access_token` (15m) + `refresh_token` (7d) in httpOnly cookies.
* `POST /auth/refresh` — Rotate single-use refresh token.
* `POST /auth/logout` — Revoke active refresh token.
* `GET /auth/me` — Inspect authenticated user session.

### Notes Management (`/notes` — Protected)
* `POST /notes` — Create note (optional passphrase triggers AES-256-GCM encryption).
* `GET /notes` — List user notes (pagination supported).
* `GET /notes/:id` — Get note metadata and content.
* `POST /notes/:id/decrypt` — Decrypt zero-knowledge ciphertext with passphrase.
* `PATCH /notes/:id` — Update note title or encrypted content.
* `DELETE /notes/:id` — Soft-delete note and cascade purge Cloudinary assets.
* `POST /notes/:id/attachments` — Upload media (images/PDFs) to Cloudinary.
* `DELETE /notes/:id/attachments/:attachmentId` — Remove media attachment.

### Links & Analytics (`/links` — Protected)
* `POST /links` — Generate Base62 link for a note (burn-on-read, expiry, passphrase, webhook options).
* `GET /links` — List user links.
* `GET /links/:id` — Get link status and metadata.
* `GET /links/:id/analytics` — Get aggregated time-series clicks, devices, OS, browsers, referrers.
* `DELETE /links/:id` — Invalidate link.

### Webhooks (`/webhooks` — Protected)
* `POST /webhooks` — Register outbound webhook destination URL (generates HMAC secret).
* `GET /webhooks` — List registered webhooks.
* `GET /webhooks/:id` — Inspect webhook details and HMAC secret.
* `DELETE /webhooks/:id` — Remove webhook registration.

### Public Slug Resolution (`/:slug` — Public)
* `GET /:slug` — Resolve content or receive passphrase challenge (`requiresPassphrase: true`).
* `POST /:slug` — Submit passphrase in request body to unlock content.

---

## License
ISC

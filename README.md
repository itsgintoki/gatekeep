# GateKeep

> **Encrypted Ephemeral Content Sharing Engine** with cryptographic access gates, rate limiting, HMAC-signed webhooks, and compound-indexed analytics.

Live app: [gatekeep-6lhv.onrender.com](https://gatekeep-6lhv.onrender.com) · [Health check](https://gatekeep-6lhv.onrender.com/health)

## Browser App

Open `/` for the GateKeep workspace. The frontend uses a cream, ink, orange, and monospace visual style, with responsive layouts and a dark theme.

* Sign up and sign in, then create, edit, encrypt, unlock, and delete notes.
* Search all note titles, pin notes, autosave existing notes, duplicate content, export Markdown, and see word counts and reading time.
* Manage note attachments, sharing links, expiry dates, passphrases, and read limits. Copy links or display their QR codes from the editor.
* Inspect each link's status and access analytics, and manage webhook destinations.
* Copy a `/share/:slug` URL for recipients. Loading this page only checks availability. A read is consumed when the recipient explicitly submits **Open note**.
* Use Ctrl/⌘ + S (save), N (new), P (pin), D (duplicate), or K (copy link). The **?** menu also offers logout from all sessions; existing access tokens expire within 15 minutes.

Notes are private until you explicitly create a link. New notes need an initial manual save; existing notes autosave after 1.5 seconds unless encryption settings are changing. Duplicates copy content without copying attachments or links. Uploads support JPEG, PNG, GIF, WebP, PDF, Word, MP4, WebM, Ogg, and MOV files up to 30 MB. Shared pages preview images, PDFs, and video after successful access; other files open through a download link.

A note's encryption passphrase and a link's access passphrase are separate. If both are set, the recipient needs both. Incorrect passphrases do not consume a read. Note encryption happens on the server; it is encryption at rest, not end-to-end encryption. Files are held in a private Supabase Storage bucket and are not encrypted by the note passphrase. Owners and successful share-link recipients receive signed URLs that expire after 15 minutes. A downloaded copy remains with its recipient, and an issued URL remains usable until expiry even after the share link burns.

The app uses the existing httpOnly session cookies. Only the theme preference is stored in localStorage; note content, passphrases, and tokens are not saved there. The frontend and API share one Express origin and one deployment, with no separate frontend framework or service.

---

## Key Architecture & Technical Highlights

* **AES-256-GCM Encryption at Rest:** The API encrypts note content with `scrypt` key derivation, a random 16-byte salt, 12-byte IV, and 128-bit authentication tag. Plaintext is not stored in PostgreSQL, but the API receives plaintext and passphrases during encryption and decryption.
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
* Node.js >= 22
* Docker & Docker Compose

### 2. Environment Configuration
```bash
npm ci
cp .env.example .env
```

Fill in the database connection and JWT secrets. Supabase Storage credentials are optional locally: the app starts without them and disables uploads. Production cookie sessions require HTTPS. When using a reverse proxy, set `TRUST_PROXY` to its trusted hop count. Same-origin browser requests are accepted automatically; add other trusted frontend origins to `ALLOWED_ORIGINS` only when needed.

### 3. Local Development (with Docker Postgres)
```bash
# Start PostgreSQL container on port 5433
docker compose up -d postgres

# Start development server with live reload; migrations run automatically
npm run dev
```

Open `http://localhost:3000`. The command builds the browser TypeScript before starting the server. During frontend development, run `npm run dev:client` in a second terminal to watch TypeScript edits; HTML and CSS are served directly from `public/` in development. Reload the browser after editing.

`npm run build` compiles the API and browser TypeScript and copies the HTML/CSS into `dist/public/`. Docker includes those assets in the existing application image. `npm run typecheck` checks both TypeScript projects.

### 4. Running Tests
```bash
npm run build
npm test
npm run test:integration
```

Integration tests use the PostgreSQL database in `DATABASE_URL`; use a dedicated test database. They create their own users and clean them up afterward.

### 5. Full Containerized Production Run
```bash
docker compose up --build
```

### 6. Render deployment

Render hosts the browser app and Express API; Supabase provides PostgreSQL and private file storage. Create a Render Blueprint from this repository using `render.yaml`. It creates one free Node.js web service, builds both TypeScript projects, generates JWT secrets, and runs migrations before listening.

Set these server-side environment variables in Render:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase PostgreSQL connection URI; use the Session pooler on IPv4-only hosts and TLS |
| `DATABASE_SCHEMA` | `gatekeep` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase secret/service-role key, never sent to the browser |
| `SUPABASE_STORAGE_BUCKET` | `gatekeep` |

For verified TLS, download the certificate from the official **Database Settings** certificate link in Supabase and add it to Render as a secret file named `prod-ca-2021.crt`. Render mounts it at `/etc/secrets/prod-ca-2021.crt`. Set the `DATABASE_URL` query options to `sslmode=verify-full&sslrootcert=/etc/secrets/prod-ca-2021.crt`, replacing any existing `sslmode` or `sslrootcert` options.

Create a **private** `gatekeep` storage bucket with a 30 MB limit and the supported MIME types. The API authorizes users and links before issuing temporary file URLs. Do not make the bucket public. `/config` reports whether upload credentials are configured; `/health` is the deployment health check.

Gatekeep uses its own `gatekeep` schema and `gatekeep_migrations` history. It does not use Supabase Auth or expose database credentials to the frontend. Existing standalone installations can retain `DATABASE_SCHEMA=public`. Never commit secrets.

#### Moving an existing Gatekeep database

Run the one-time transfer manually from a CLI after building the application:

```bash
DATABASE_URL='<new-database-url>' SOURCE_DATABASE_URL='<old-database-url>' node dist/db/copyDatabase.js
```

The source schema defaults to `gatekeep`. Stop writes to the old app during transfer. The command migrates an empty destination, copies Gatekeep records transactionally, checks counts, and records completion so it cannot import twice. It refuses to overwrite a nonempty destination or copy the shared `public` schema. It reads one table into memory at a time, so use PostgreSQL backup tools for larger deployments. Keep this import out of the service startup command and remove `SOURCE_DATABASE_URL` after a successful transfer.

Existing Cloudinary attachments require a separate object migration before applying the storage migration; the migration refuses to proceed if attachment rows remain. The original hosted Gatekeep instance had uploads disabled. After verifying a transfer, retire the source database.

---

## API Reference

### Authentication (`/auth`)
* `POST /auth/signup` — Register new user account.
* `POST /auth/login` — Authenticate and receive `access_token` (15m) + `refresh_token` (7d) in httpOnly cookies.
* `POST /auth/refresh` — Rotate single-use refresh token.
* `POST /auth/logout` — Revoke active refresh token.
* `POST /auth/logout-all` — Revoke every refresh token owned by the authenticated user.
* `GET /auth/me` — Inspect authenticated user session.

### Notes Management (`/notes` — Protected)
* `POST /notes` — Create note (optional passphrase triggers AES-256-GCM encryption).
* `GET /notes` — List user notes with `page`, `limit`, and literal title `search`; pinned notes first.
* `GET /notes/:id` — Get note metadata and content.
* `POST /notes/:id/decrypt` — Decrypt server-side ciphertext with its passphrase.
* `PATCH /notes/:id` — Update title, content, `isPinned`, or encryption settings.
* `DELETE /notes/:id` — Soft-delete note and remove its Supabase files.
* `POST /notes/:id/attachments` — Upload images, PDF, Word, or video to private Supabase Storage (30 MB maximum).
* `DELETE /notes/:id/attachments/:attachmentId` — Remove media attachment.

### Links & Analytics (`/links` — Protected)
* `POST /links` — Generate Base62 link for a note (burn-on-read, expiry, passphrase, webhook options).
* `GET /links` — List user links.
* `GET /links/:id` — Get link status and metadata.
* `GET /links/:id/qr` — Get an authenticated SVG QR code for the owned link.
* `GET /links/:id/analytics` — Get aggregated time-series clicks, devices, OS, browsers, referrers.
* `DELETE /links/:id` — Invalidate link.

### Webhooks (`/webhooks` — Protected)
* `POST /webhooks` — Register outbound webhook destination URL (generates HMAC secret).
* `GET /webhooks` — List registered webhooks.
* `GET /webhooks/:id` — Inspect webhook details and HMAC secret.
* `DELETE /webhooks/:id` — Remove webhook registration.

### Public Slug Resolution (`/:slug` — Public)
* `GET /:slug` — Inspect link availability and whether a passphrase is required; never consumes a read.
* `POST /:slug` — Explicitly consume one read and optionally submit a link `passphrase`. Supply `notePassphrase` to decrypt an encrypted note before consuming the read. Without `notePassphrase`, the existing ciphertext response is preserved.
* `GET /share/:slug` — Browser recipient page; opening the page itself never consumes a read.

---

## License
ISC

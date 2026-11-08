# GateKeep Backend Navigation — 3 Phases

> Backend-focused. Read in order. Each phase answers one question.
> Code headers are tagged `[Phase 1]`, `[Phase 2]`, `[Phase 3]` so you always know where you are.

**How to jump:** Ctrl/Cmd+click any link below (e.g. [`src/index.ts:48`](./src/index.ts#L48)). Links point to the file + line.

**Pre-req:** `cp .env.example .env`, `docker compose up -d postgres`, `npm run dev`.
Open `http://localhost:3000/health` to confirm boot.

> **Track:** GateKeep = Web & Security Backend track (HTTP/REST/Express,
> authN/authZ, sessions/JWT/cookies, Argon2id, AES-256-GCM/HMAC, CORS/SQLi/XSS/CSRF,
> networking/DNS/TLS). Companion theory: `brain/GateKeep-Study-Guide.md`.
> IdleForge = Backend Systems track (JS/TS/Node, SQL/PG/indexes/transactions,
> Redis/caching, rate-limit mechanics, BullMQ/delivery/retries/idempotency, OS) —
> learn those once in IdleForge; this file marks where GateKeep *applies* them
> (`consumeLink` atomic burn, outbox `SKIP LOCKED` claim, tiered limits).

---

## Phase 1 — Foundation: how does the server run + who are you?

**Goal:** trace one request from socket to DB and back. Understand boot, pipeline, auth.

### 1.1 Boot — [`src/index.ts:48`](./src/index.ts#L48)
**WHAT:** `validateRuntimeConfig()` → `runMigrations()` → `SELECT 1` health-check → start 1s webhook poller → `app.listen()`.
**WHY this order:** fail fast on bad secrets before binding a port; never serve traffic on an unmigrated DB; background worker must not crash boot (errors are logged, not thrown).
**DESIGN:** webhook poller uses `unref()` + `webhookWorkerRunning` guard — process can exit cleanly, ticks never overlap.

### 1.2 Pipeline — [`src/app.ts:37`](./src/app.ts#L37)
**WHAT:** `helmet → cors → json(1mb) → cookieParser → static → no-store → /auth,/notes,/links,/webhooks → /health,/config → /:slug → errorHandler`.
**WHY this order:** security headers first; `/:slug` mounted LAST so it can't shadow `/auth` etc.; `errorHandler` MUST be last to catch `next(err)`.
**DESIGN decisions:**
- `TRUST_PROXY` hop count → correct `req.ip` behind Render/Nginx (rate-limit + audit depend on it).
- Dynamic CORS allowlist + `credentials:true` → cookies work, strangers blocked.
- `Cache-Control: no-store` → burn-after-read notes never cached by browser.
- Helmet CSP extended with Supabase origin → attachment `<img>` not blocked.

### 1.3 Data shape — [`src/db/schema.ts:1`](./src/db/schema.ts#L1), [`src/db/index.ts:1`](./src/db/index.ts#L1)
**WHAT:** 8 tables: `users → notes → attachments`, `notes → links → accessLogs`, `users → webhooks → webhookDeliveries`, `users → refreshTokens`.
**WHY:** single file = one mental model; `$inferSelect` types flow into every service.
**DESIGN:**
- Soft-delete (`notes.deletedAt`) not hard delete — preserves link/analytics history.
- `links { slug unique, passphraseHash?, expiresAt?, maxReads?, readsCount, isBurned }` — all burn logic lives here.
- `webhook_deliveries` is a durable outbox queue (not a log) — worker polls it.
- `search_path=<DATABASE_SCHEMA>` — one Postgres hosts isolated schemas (tests/tenants); strict regex whitelist prevents option-injection. Pool `max:5` fits Render free tier.

### 1.4 Who are you — auth slice
Read in order:
1. [`auth.routes.ts:1`](./src/modules/auth/auth.routes.ts#L1) — route → controller map, `authLimiter` on signup/login only.
2. [`auth.validation.ts:1`](./src/modules/auth/auth.validation.ts#L1) — Zod trims/lowercases email, 8+ char password (NIST-style, no complexity regex).
3. [`auth.controller.ts:1`](./src/modules/auth/auth.controller.ts#L1) — validates → service → `httpOnly + Secure + SameSite=Strict` cookies; refresh cookie scoped to `/auth` (least privilege).
4. [`auth.service.ts:1`](./src/modules/auth/auth.service.ts#L1) — argon2id (64MB/3 passes) hash/verify; dummy hash on unknown email (timing-attack defence); rotation in ONE `db.transaction` (revoke old + insert new, replay → 401); only `SHA-256(token)` stored.
5. [`lib/jwt.ts:1`](./src/lib/jwt.ts#L1) — 15m access (stateless, no DB hit) + 7d refresh (`{sub,jti}`); `hashToken` means DB leak ≠ usable tokens.
6. [`authenticate.ts:1`](./src/middleware/authenticate.ts#L1) — accepts `Bearer` OR cookie, sets `req.user`; `TOKEN_EXPIRED` code tells frontend to call `/refresh`.
7. [`errorHandler.ts:1`](./src/middleware/errorHandler.ts#L1) — `MulterError → 400`, `ZodError → 400 {field,message}`, `{status} → that code`, else `500` (stack only in dev).

**✅ Phase 1 exit check:** can you explain why access tokens live 15m but refresh tokens are revocable? What happens if you delete `app.use(errorHandler)` position?

---

## Phase 2 — Core domain: what does the app actually do?

**Goal:** follow note → share-link → public unlock. This is the money path.

### 2.1 Notes (private CRUD) — [`src/modules/notes/`](./src/modules/notes/)
1. [`notes.routes.ts:1`](./src/modules/notes/notes.routes.ts#L1) — `router.use(authenticate)` = everything below is private.
2. [`notes.validation.ts:1`](./src/modules/notes/notes.validation.ts#L1) — `.refine()` rejects empty PATCH; `newPassphrase: string | null | undefined` = set / strip / keep.
3. [`notes.controller.ts:1`](./src/modules/notes/notes.controller.ts#L1) — thin adapters; `req.user!.id` is safe because of (1).
4. [`notes.service.ts:1`](./src/modules/notes/notes.service.ts#L1) — **ownership rule:** every query has `eq(userId) + isNull(deletedAt)`, miss → `404` (never `403`, avoids ID oracle).
   - Create encrypts iff `passphrase` present ([`lib/crypto.ts`](./src/lib/crypto.ts)).
   - List selects light columns only (no `content`), escapes LIKE wildcards, pinned-first; counts derived in JS.
   - Get swaps `storagePath` → 15-min signed URL (bucket stays private).
   - Update delegates to [`lib/noteContent.ts`](./src/lib/noteContent.ts) state machine (must decrypt → patch text → re-encrypt with fresh salt/IV; can't patch ciphertext in place).
   - Delete removes Supabase objects FIRST (no cross-system rollback), then DB txn: delete attachments + soft-delete note.
   - Upload does external write first, DB insert second, orphan cleanup on failure (compensating action).

### 2.2 Crypto + IDs + files
- [`lib/crypto.ts:1`](./src/lib/crypto.ts#L1) — **WHAT:** `salt:iv:authTag:ciphertext` (hex). **WHY AES-256-GCM:** authTag fails closed on wrong passphrase/tamper instead of returning garbage. **WHY scrypt:** memory-hard KDF slows GPUs vs SHA-256. Random salt+IV per note → identical text encrypts differently. Server never stores passphrase → lost = unrecoverable.
- [`lib/noteContent.ts:1`](./src/lib/noteContent.ts#L1) — pure state machine (no DB), unit-testable matrix for encrypt/rotate/strip.
- [`lib/base62.ts:1`](./src/lib/base62.ts#L1) — 7 random bytes mod 62 ≈ 41 bits (~2T combos); `links.service` retries 5× on collision, DB unique constraint is final guard. URL-safe, no escaping.
- [`lib/storage.ts:1`](./src/lib/storage.ts#L1) — DB holds metadata only; bytes in Supabase. `upsert:false` never overwrites; `createSignedUrl` 15-min TTL limits leak window; missing env → `503` (degrade, don't crash); path `<userId>/<noteId>/<uuid>` is scoped + unguessable.

### 2.3 Links (owner view) — [`src/modules/links/`](./src/modules/links/)
- [`links.service.ts:33`](./src/modules/links/links.service.ts#L33) `createLink`: verify note owned → verify webhook owned → argon2-hash passphrase (hash, not encrypt — only `verify` needed) → collision-checked slug → return `hasPassphrase:boolean` (never leak hash).
- `listLinks`: two-step (notes for titles → `inArray(noteIds)`) + JS `noteTitleMap` join.
- `getLink/deleteLink`: ownership via joined `link.note.userId`, `404` on cross-user.
- `getLinkAnalytics`: 7 parallel queries (`Promise.all`): totals + `DISTINCT ip`, `GROUP BY` date/browser/os/device/referrer via `sql` fragments (`to_char`, `COALESCE` so NULLs bucket to Unknown). IPv4 masked `1.2.3.***` for privacy.

### 2.4 Resolve (public unlock) — [`src/modules/resolve/`](./src/modules/resolve/) ⭐ read slowly
- [`resolve.routes.ts:1`](./src/modules/resolve/resolve.routes.ts#L1) — `GET /:slug` = free probe, `POST /:slug` = spends a read.
- [`resolve.validation.ts:1`](./src/modules/resolve/resolve.validation.ts#L1) — link passphrase vs `notePassphrase` are SEPARATE layers (two passwords possible).
- [`resolve.controller.ts:1`](./src/modules/resolve/resolve.controller.ts#L1) — snapshots `{ip, userAgent, referrer}` per view for logs + webhook payloads.
- [`resolve.service.ts:80`](./src/modules/resolve/resolve.service.ts#L80) `loadAvailableLink`: 404 unknown/deleted (same response), 410 burned, lazy-burn expired (no cron needed — flip on first sighting).
- [`resolve.service.ts:224`](./src/modules/resolve/resolve.service.ts#L224) `resolveLink`: (1) argon2 verify — missing → `{requiresPassphrase:true}` (no read spent), wrong → 401 (no read spent). (2) decrypt IN MEMORY first — bad `notePassphrase` throws BEFORE counter moves (typo never burns a 1-read link). (3) sign attachment URLs. (4) `consumeLink`.
- [`resolve.service.ts:142`](./src/modules/resolve/resolve.service.ts#L142) `consumeLink` — **the critical transaction:** single `UPDATE ... readsCount+1, isBurned=CASE(...) WHERE live AND unexpired AND reads<maxReads RETURNING`. The `WHERE` is a compare-and-swap: winner gets a row, concurrent loser gets 0 rows → 410. Then `INSERT accessLogs` (parsed UA + `referrerHost`) + queue `link.accessed` (+ `link.burned` if just died) into outbox. All-or-nothing — log failure rolls back the counter.
- **Reuse note:** the transaction/locking theory behind this CAS is owned by IdleForge (§§14/16 — `FOR UPDATE`, atomic conditional updates). This section is the applied proof: `remainingReads=1` hit twice concurrently must yield exactly one success.

**✅ Phase 2 exit check:** trace `POST /:slug` with `maxReads:1` hit twice concurrently — which SQL clause guarantees exactly one success? Why is decrypt done before `consumeLink`?

---

## Phase 3 — Production hardening: how does it survive the real world?

**Goal:** abuse, failure, and observability. Why each guard exists.

### 3.1 Webhooks (async notify) — [`lib/webhook.ts:1`](./src/lib/webhook.ts#L1), [`src/modules/webhooks/`](./src/modules/webhooks/)
**WHAT:** `resolve` only `INSERT`s into `webhook_deliveries`; `index.ts` polls every 1s via `processWebhookDeliveries(limit=20)`.
**WHY outbox, not inline POST:** link unlock stays fast; target downtime doesn't fail the read; retries with backoff.
**DESIGN:**
- `claimWebhookDeliveries`: one CTE with `FOR UPDATE SKIP LOCKED` — multi-instance safe, stale `lockedAt>5m` reclaimable after crash; `attempts++` atomic.
- `deliverClaimedWebhook`: HMAC-SHA256 body → `X-GateKeep-Signature-256` (receiver recomputes, timing-safe compare).
- `recordDeliveryFailure`: backoff `0.5s,1s,2s,4s,8s` (cap 60s), 5 tries → `failedAt` dead-letter (kept for audit).
- Registry ([`webhooks.service.ts:19`](./src/modules/webhooks/webhooks.service.ts#L19)): SSRF-gate BEFORE insert (fail closed); list OMITS `secret` (logs/caches safe); delete `SET NULL`s `links.webhookId` (links survive, go quiet).

### 3.2 SSRF firewall — [`lib/webhookHttp.ts:1`](./src/lib/webhookHttp.ts#L1) ⭐
**THREAT:** user-supplied webhook URL could point at `169.254.169.254` (cloud metadata) or `localhost:5432`.
**DEFENCE in layers:** (1) HTTPS-only, no creds. (2) `BlockList` of private/reserved IPv4+IPv6 CIDRs. (3) DNS-resolve hostname, reject if ANY record blocked. (4) custom `lookup` re-validates at socket-connect (closes DNS-rebinding TOCTOU). (5) max 3 redirects, each re-validated. 5s timeout so worker never hangs.

### 3.3 Rate limits + uploads + analytics edges
- [`rateLimiter.ts:18`](./src/middleware/rateLimiter.ts#L18) — sliding window per-IP timestamp arrays (no fixed-window boundary burst); IETF `RateLimit-*` + `Retry-After`; 5-min sweeper prevents leak; keyed by `req.ip` (hence Phase 1 `TRUST_PROXY`). Tiers: auth 10/15m (brute-force), resolve 60/min (scraping), API 120/15m (CRUD). Algorithm mechanics (fixed/sliding/token/leaky, shared counters) are owned by IdleForge — this section owns the abuse rationale.
- [`upload.ts:1`](./src/middleware/upload.ts#L1) — Multer memory storage → `req.file.buffer`; 30MB cap (`LIMIT_FILE_SIZE → 400`); MIME allowlist (images/PDF/Word/video — blocks executables, not antivirus).
- [`userAgent.ts:1`](./src/lib/userAgent.ts#L1) — zero-dep UA parser, bots first (avoid Chrome misclassify), coarse buckets for dashboard; stamped at view time, backfilled on read.
- [`runtimeConfig.ts:1`](./src/lib/runtimeConfig.ts#L1) — prod fail-fast: secrets ≥32 chars, no `your_` placeholders, no dev `gatekeep_secret` in `DATABASE_URL`. Dev no-ops for DX.
- [`migrate.ts:1`](./src/db/migrate.ts#L1) — `public` migrates directly; custom schema copies `./drizzle` to tempdir, rewrites `"public".` qualifiers, separate bookkeeping schema (checked-in SQL untouched).
- [`copyDatabase.ts:1`](./src/db/copyDatabase.ts#L1) — one-shot schema→schema CLI: refuses `public` source, requires empty target, refuses if attachments exist (objects move separately), `REPEATABLE READ` snapshot, idempotent marker row. Demo-scale (one table in memory — use `pg_dump` for large).

**✅ Phase 3 exit check:** why does `safeLookup` exist if `resolvePublicAddresses` already checked DNS? What happens to in-flight `readsCount` if webhook POST times out?

---

## Map — where to jump

| Want to change… | Start here |
|---|---|
| Auth/token lifetimes | [`lib/jwt.ts`](./src/lib/jwt.ts) , [`auth.service.ts:150`](./src/modules/auth/auth.service.ts#L150) |
| Password/link-passphrase cost | `ARGON2_OPTIONS` in [`auth.service.ts:30`](./src/modules/auth/auth.service.ts#L30), [`links.service.ts:26`](./src/modules/links/links.service.ts#L26) |
| Note encryption format | [`lib/crypto.ts:25`](./src/lib/crypto.ts#L25) |
| Share-link rules | [`resolve.service.ts:142`](./src/modules/resolve/resolve.service.ts#L142) |
| Rate limits | [`rateLimiter.ts:91`](./src/middleware/rateLimiter.ts#L91) |
| Webhook retry/backoff | [`lib/webhook.ts:40,93`](./src/lib/webhook.ts#L40) |
| SSRF policy | [`lib/webhookHttp.ts:10`](./src/lib/webhookHttp.ts#L10) |
| Upload types/size | [`upload.ts:3`](./src/middleware/upload.ts#L3), [`lib/storage.ts:19`](./src/lib/storage.ts#L19) |
| Analytics breakdowns | [`links.service.ts:198`](./src/modules/links/links.service.ts#L198) |
| DB tables | [`src/db/schema.ts`](./src/db/schema.ts) |
| Ops (migrate/copy) | [`db/migrate.ts`](./src/db/migrate.ts), [`db/copyDatabase.ts`](./src/db/copyDatabase.ts) |

// ============================================================================
// [Phase 2 — Core domain] src/lib/storage.ts — SUPABASE STORAGE WRAPPER
// See NAVIGATION.md Phase 2.2. WHAT: metadata in PG, bytes in Supabase.
// WHY signed URLs (15m): private bucket stays private. WHY upsert:false:
// never silently overwrite. DESIGN: 503 when unconfigured (degrade, not crash).
// ----------------------------------------------------------------------------
// DB holds only metadata (attachments table); this module talks to Supabase:
//   uploadBuffer(path, buffer, mime) — writes object (upsert:false = never
//                                      silently overwrite).
//   createSignedUrl(path) — 15-min time-limited URL so private files can be
//                           viewed without making the bucket public.
//   deleteAsset(path)     — removes on note/attachment delete.
// Path scheme: "<userId>/<noteId>/<uuid>" (user-scoped, unguessable).
// CONCEPT — lazy cached client: created once per credential set; throws
// 503 (not 500) when env is missing so /config + UI can degrade gracefully
// ("uploads unavailable" instead of crash). storageOrigin() feeds Helmet CSP.
// ============================================================================
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Signed URLs expire quickly to limit leak window if a URL is shared.
const SIGNED_URL_TTL_SECONDS = 15 * 60;

let cachedClient: SupabaseClient | undefined;
let cachedCredentials = "";

function config() {
  return {
    url: process.env.SUPABASE_URL?.trim() ?? "",
    key: process.env.SUPABASE_SERVICE_KEY?.trim() ?? "",
    bucket: process.env.SUPABASE_STORAGE_BUCKET?.trim() || "gatekeep",
  };
}

function storageClient(): SupabaseClient {
  const { url, key } = config();
  if (!url || !key) {
    throw Object.assign(
      new Error("Uploads are unavailable until Supabase Storage is configured."),
      { status: 503 }
    );
  }

  const credentials = `${url}\n${key}`;
  if (!cachedClient || cachedCredentials !== credentials) {
    cachedClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    cachedCredentials = credentials;
  }
  return cachedClient;
}

function storageError(message: string): Error {
  return Object.assign(new Error(`Supabase Storage: ${message}`), { status: 502 });
}

export function storageConfigured(): boolean {
  const { key } = config();
  return Boolean(key && storageOrigin());
}

export function storageOrigin(): string | undefined {
  const { url } = config();
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function createStoragePath(userId: string, noteId: string): string {
  return `${userId}/${noteId}/${randomUUID()}`;
}

export async function uploadBuffer(
  path: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  const { bucket } = config();
  const { error } = await storageClient().storage
    .from(bucket)
    .upload(path, buffer, { contentType, upsert: false });
  if (error) throw storageError(error.message);
}

export async function createSignedUrl(path: string): Promise<string> {
  const { bucket } = config();
  const { data, error } = await storageClient().storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw storageError(error.message);
  return data.signedUrl;
}

export async function deleteAsset(path: string): Promise<void> {
  const { bucket } = config();
  const { error } = await storageClient().storage.from(bucket).remove([path]);
  if (error) throw storageError(error.message);
}

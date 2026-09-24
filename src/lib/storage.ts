import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

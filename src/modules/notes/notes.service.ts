// ============================================================================
// [Phase 2 — Core domain] src/modules/notes/notes.service.ts — NOTE LOGIC
// See NAVIGATION.md Phase 2.1. WHAT: owned CRUD + signed URLs + orphan cleanup.
// WHY every query scopes userId + deletedAt: no ID oracle (404 not 403).
// DESIGN: external storage write first, DB second, compensate on failure.
// ----------------------------------------------------------------------------
// Ownership rule: EVERY query includes eq(notes.userId, userId) + soft-delete
// filter isNull(deletedAt). Missing row -> 404 (never 403, to avoid leaking
// which IDs exist for other users).
// Encryption: create encrypts if passphrase given; update delegates the
// state machine to prepareNoteContent() (lib/noteContent.ts); decryptNote
// verifies passphrase and returns plaintext WITHOUT persisting it.
// List: lightweight columns only (no content!) + LIKE-escaped title search
// (% _ \ escaped) + pinned-first ordering; attachmentCount/totalReads are
// derived in JS from joined relations.
// Attachments: uploadBuffer -> INSERT metadata; on DB failure the orphaned
// object is deleted (compensating action). Delete: storage objects removed
// FIRST, then DB rows in a transaction, note soft-deleted (deletedAt set).
// Signed URLs (15-min) are minted on read so the bucket stays private.
// ============================================================================
import { and, eq, isNull, desc, ilike } from "drizzle-orm";
import { db } from "../../db/index";
import { notes, attachments } from "../../db/schema";
import { createSignedUrl, createStoragePath, deleteAsset, uploadBuffer } from "../../lib/storage";
import { encryptText, decryptText } from "../../lib/crypto";
import { prepareNoteContent } from "../../lib/noteContent";
import type { CreateNoteInput, UpdateNoteInput } from "./notes.validation";

export async function createNote(userId: string, data: CreateNoteInput) {
  const isEncrypted = Boolean(data.passphrase);
  const content = data.passphrase ? encryptText(data.content, data.passphrase) : data.content;

  const [note] = await db
    .insert(notes)
    .values({
      userId,
      title: data.title,
      content,
      isEncrypted,
    })
    .returning();

  return note;
}

export async function listNotes(userId: string, page: number, limit: number, search = "") {
  const offset = (page - 1) * limit; // Classic offset pagination (fine at this scale).

  const rows = await db.query.notes.findMany({
    where: and(eq(notes.userId, userId), isNull(notes.deletedAt),
      // Escape LIKE wildcards so searching "100%" doesn't match everything.
      search ? ilike(notes.title, `%${search.replace(/[%_\\]/g, "\\$&")}%`) : undefined),
    orderBy: [desc(notes.isPinned), desc(notes.createdAt), desc(notes.id)],
    limit,
    offset,
    columns: {
      id: true,
      title: true,
      isEncrypted: true,
      isPinned: true,
      updatedAt: true,
      createdAt: true,
    },
    with: { attachments: { columns: { id: true } }, links: { columns: { readsCount: true } } },
  });

  return rows.map((n) => ({
    ...n,
    attachmentCount: n.attachments.length,
    totalReads: n.links.reduce((total, link) => total + link.readsCount, 0),
    attachments: undefined,
    links: undefined,
  }));
}

export async function getNote(noteId: string, userId: string) {
  const note = await db.query.notes.findFirst({
    where: and(
      eq(notes.id, noteId),
      eq(notes.userId, userId),
      isNull(notes.deletedAt)
    ),
    // Eager-load relations in one round trip (Drizzle `with` = JOINs).
    with: { attachments: true, links: { columns: { id: true, slug: true, readsCount: true, isBurned: true, expiresAt: true, maxReads: true } } },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }
  return {
    ...note,
    // Never expose raw storagePath — swap it for a short-lived signed URL.
    attachments: await Promise.all(note.attachments.map(async ({ storagePath, ...attachment }) => ({
      ...attachment,
      url: await createSignedUrl(storagePath),
    }))),
  };
}

export async function decryptNote(noteId: string, userId: string, passphrase: string) {
  const note = await getNote(noteId, userId);

  if (!note.isEncrypted) {
    return note;
  }

  const decryptedContent = decryptText(note.content, passphrase);

  return {
    ...note,
    content: decryptedContent,
  };
}


export async function updateNote(
  noteId: string,
  userId: string,
  data: UpdateNoteInput
) {
  const existing = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt)),
  });

  if (!existing) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }

  const contentUpdate = data.content !== undefined || data.newPassphrase !== undefined
    ? prepareNoteContent(existing, data)
    : {};

  const [updated] = await db
    .update(notes)
    .set({
      title: data.title,
      ...contentUpdate,
      isPinned: data.isPinned,
      updatedAt: new Date(),
    })
    .where(
      and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt))
    )
    .returning();

  return updated;
}

export async function deleteNote(noteId: string, userId: string) {
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt)),
    with: { attachments: { columns: { storagePath: true, id: true } } },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }

  // Best-effort external cleanup first: Supabase has no rollback with Postgres,
  // so delete objects before touching the DB (orphan DB rows are re-cleanable).
  await Promise.all(
    note.attachments.map((attachment) =>
      deleteAsset(attachment.storagePath)
    )
  );

  // Then atomically: drop attachment rows + soft-delete the note (keeps links/logs).
  await db.transaction(async (tx) => {
    if (note.attachments.length > 0) {
      await tx.delete(attachments).where(eq(attachments.noteId, noteId));
    }
    await tx
      .update(notes)
      .set({ deletedAt: new Date() })
      .where(eq(notes.id, noteId));
  });
}

export async function uploadAttachment(
  noteId: string,
  userId: string,
  file: Express.Multer.File
) {
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt)),
    columns: { id: true },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }

  const storagePath = createStoragePath(userId, noteId); // Namespaced, unguessable key.
  await uploadBuffer(storagePath, file.buffer, file.mimetype); // External side-effect first.

  try {
    const url = await createSignedUrl(storagePath);
    const [attachment] = await db
      .insert(attachments)
      .values({
        noteId,
        storagePath, // Internal key kept in DB; API returns only the signed `url`.
        originalName: file.originalname.slice(0, 255),
        mimeType: file.mimetype,
        sizeBytes: file.size,
      })
      .returning();
    const { storagePath: _storagePath, ...response } = attachment; // Strip internal key.
    return { ...response, url };
  } catch (error) {
    // Compensating transaction: DB failed after upload -> remove orphan object.
    try {
      await deleteAsset(storagePath);
    } catch (cleanupError) {
      console.error("Failed to clean up uploaded asset after database error:", cleanupError);
    }
    throw error;
  }
}

export async function deleteAttachment(
  noteId: string,
  attachmentId: string,
  userId: string
) {
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt)),
    columns: { id: true },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }

  const attachment = await db.query.attachments.findFirst({
    where: and(
      eq(attachments.id, attachmentId),
      eq(attachments.noteId, noteId)
    ),
  });
  if (!attachment) {
    throw Object.assign(new Error("Attachment not found"), { status: 404 });
  }

  await deleteAsset(attachment.storagePath);
  await db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.noteId, noteId)));
}

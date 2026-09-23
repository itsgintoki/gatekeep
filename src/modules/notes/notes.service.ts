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
  const offset = (page - 1) * limit;

  const rows = await db.query.notes.findMany({
    where: and(eq(notes.userId, userId), isNull(notes.deletedAt),
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
    with: { attachments: true, links: { columns: { id: true, slug: true, readsCount: true, isBurned: true, expiresAt: true, maxReads: true } } },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }
  return {
    ...note,
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

  await Promise.all(
    note.attachments.map((attachment) =>
      deleteAsset(attachment.storagePath)
    )
  );

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

  const storagePath = createStoragePath(userId, noteId);
  await uploadBuffer(storagePath, file.buffer, file.mimetype);

  try {
    const url = await createSignedUrl(storagePath);
    const [attachment] = await db
      .insert(attachments)
      .values({
        noteId,
        storagePath,
        originalName: file.originalname.slice(0, 255),
        mimeType: file.mimetype,
        sizeBytes: file.size,
      })
      .returning();
    const { storagePath: _storagePath, ...response } = attachment;
    return { ...response, url };
  } catch (error) {
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

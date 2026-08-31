import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "../../db/index";
import { notes, attachments } from "../../db/schema";
import { uploadBuffer, deleteAsset } from "../../lib/cloudinary";
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

export async function listNotes(userId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const rows = await db.query.notes.findMany({
    where: and(eq(notes.userId, userId), isNull(notes.deletedAt)),
    orderBy: desc(notes.createdAt),
    limit,
    offset,
    columns: {
      id: true,
      title: true,
      isEncrypted: true,
      createdAt: true,
    },
    with: { attachments: { columns: { id: true } } },
  });

  return rows.map((n) => ({
    ...n,
    attachmentCount: n.attachments.length,
    attachments: undefined,
  }));
}

export async function getNote(noteId: string, userId: string) {
  const note = await db.query.notes.findFirst({
    where: and(
      eq(notes.id, noteId),
      eq(notes.userId, userId),
      isNull(notes.deletedAt)
    ),
    with: { attachments: true },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }
  return note;
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

  const { content, isEncrypted } = prepareNoteContent(existing, data);

  const [updated] = await db
    .update(notes)
    .set({
      title: data.title !== undefined ? data.title : existing.title,
      content,
      isEncrypted,
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
    with: { attachments: { columns: { cloudinaryPublicId: true, id: true } } },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }

  await Promise.all(
    note.attachments.map((attachment) =>
      deleteAsset(attachment.cloudinaryPublicId)
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

  const { url, publicId } = await uploadBuffer(file.buffer, `gatekeep/${userId}`);

  try {
    const [attachment] = await db
      .insert(attachments)
      .values({
        noteId,
        url,
        cloudinaryPublicId: publicId,
        mimeType: file.mimetype,
        sizeBytes: file.size,
      })
      .returning();
    return attachment;
  } catch (error) {
    try {
      await deleteAsset(publicId);
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

  await deleteAsset(attachment.cloudinaryPublicId);
  await db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.noteId, noteId)));
}

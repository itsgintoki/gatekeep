import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "../../db/index";
import { notes, attachments } from "../../db/schema";
import { uploadBuffer, deleteAsset } from "../../lib/cloudinary";
import type { CreateNoteInput, UpdateNoteInput } from "./notes.validation";

export async function createNote(userId: string, data: CreateNoteInput) {
  const [note] = await db
    .insert(notes)
    .values({ userId, ...data })
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

export async function updateNote(
  noteId: string,
  userId: string,
  data: UpdateNoteInput
) {
  const [updated] = await db
    .update(notes)
    .set(data)
    .where(
      and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt))
    )
    .returning();

  if (!updated) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }
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

  await Promise.allSettled(
    note.attachments.map((a) => deleteAsset(a.cloudinaryPublicId))
  );

  if (note.attachments.length > 0) {
    await db
      .delete(attachments)
      .where(eq(attachments.noteId, noteId));
  }

  await db
    .update(notes)
    .set({ deletedAt: new Date() })
    .where(eq(notes.id, noteId));
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

  const [attachment] = await db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.noteId, noteId)))
    .returning();

  if (!attachment) {
    throw Object.assign(new Error("Attachment not found"), { status: 404 });
  }

  await deleteAsset(attachment.cloudinaryPublicId);
}

import { Request, Response, NextFunction } from "express";
import * as NotesService from "./notes.service";
import {
  createNoteSchema,
  updateNoteSchema,
  decryptNoteSchema,
  listNotesQuerySchema,
} from "./notes.validation";

const param = (val: string | string[]): string =>
  Array.isArray(val) ? val[0] : val;

export async function createNote(req: Request, res: Response, next: NextFunction) {
  try {
    const data = createNoteSchema.parse(req.body);
    const note = await NotesService.createNote(req.user!.id, data);
    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
}

export async function listNotes(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit } = listNotesQuerySchema.parse(req.query);
    const data = await NotesService.listNotes(req.user!.id, page, limit);
    res.json({ data, page, limit });
  } catch (err) {
    next(err);
  }
}

export async function getNote(req: Request, res: Response, next: NextFunction) {
  try {
    const note = await NotesService.getNote(param(req.params.id), req.user!.id);
    res.json(note);
  } catch (err) {
    next(err);
  }
}

export async function decryptNote(req: Request, res: Response, next: NextFunction) {
  try {
    const { passphrase } = decryptNoteSchema.parse(req.body);
    const note = await NotesService.decryptNote(
      param(req.params.id),
      req.user!.id,
      passphrase
    );
    res.json(note);
  } catch (err) {
    next(err);
  }
}

export async function updateNote(req: Request, res: Response, next: NextFunction) {
  try {
    const data = updateNoteSchema.parse(req.body);
    const note = await NotesService.updateNote(param(req.params.id), req.user!.id, data);
    res.json(note);
  } catch (err) {
    next(err);
  }
}

export async function deleteNote(req: Request, res: Response, next: NextFunction) {
  try {
    await NotesService.deleteNote(param(req.params.id), req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function uploadAttachment(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) {
      res.status(400).json({ message: "No file provided" });
      return;
    }
    const attachment = await NotesService.uploadAttachment(
      param(req.params.id),
      req.user!.id,
      req.file
    );
    res.status(201).json(attachment);
  } catch (err) {
    next(err);
  }
}

export async function deleteAttachment(req: Request, res: Response, next: NextFunction) {
  try {
    await NotesService.deleteAttachment(
      param(req.params.id),
      param(req.params.attachmentId),
      req.user!.id
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

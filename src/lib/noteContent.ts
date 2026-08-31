import { decryptText, encryptText } from "./crypto";

export interface NoteContentState {
  content: string;
  isEncrypted: boolean;
}

export interface NoteContentUpdate {
  content?: string;
  currentPassphrase?: string;
  newPassphrase?: string | null;
}

export function prepareNoteContent(
  existing: NoteContentState,
  update: NoteContentUpdate
): NoteContentState {
  const changesContent =
    update.content !== undefined || update.newPassphrase !== undefined;
  if (!changesContent) {
    return existing;
  }

  if (!existing.isEncrypted) {
    if (update.currentPassphrase) {
      throw Object.assign(new Error("Current passphrase was provided for an unencrypted note"), {
        status: 400,
      });
    }
    const plainText = update.content ?? existing.content;
    if (update.newPassphrase) {
      return {
        content: encryptText(plainText, update.newPassphrase),
        isEncrypted: true,
      };
    }
    return { content: plainText, isEncrypted: false };
  }

  if (!update.currentPassphrase) {
    throw Object.assign(
      new Error("Current passphrase is required to change encrypted content"),
      { status: 400 }
    );
  }

  const currentPlainText = decryptText(existing.content, update.currentPassphrase);
  const nextPlainText = update.content ?? currentPlainText;
  if (update.newPassphrase === null) {
    return { content: nextPlainText, isEncrypted: false };
  }

  return {
    content: encryptText(
      nextPlainText,
      update.newPassphrase ?? update.currentPassphrase
    ),
    isEncrypted: true,
  };
}

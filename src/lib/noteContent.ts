// ============================================================================
// src/lib/noteContent.ts — PURE STATE MACHINE FOR ENCRYPTION TRANSITIONS
// ----------------------------------------------------------------------------
// Centralises "how does content+passphrase evolve on PATCH /notes/:id" so
// notes.service.ts stays thin. Pure function (no DB) — easily unit-tested.
// Matrix:
//   unencrypted + no newPassphrase        -> stays plaintext (maybe new text)
//   unencrypted + newPassphrase           -> encrypt (becomes encrypted)
//   encrypted + no currentPassphrase      -> 400 (can't verify ownership)
//   encrypted + current -> decrypt, apply text, re-encrypt with
//                          newPassphrase ?? current (rotate), or null -> strip
//                          encryption (return to plaintext).
// CONCEPT: re-encryption is required because AES ciphertext can't be patched
// in place — you must decrypt to plaintext, swap text, encrypt fresh (new
// random salt/IV each time, see crypto.ts).
// ============================================================================
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decryptText, encryptText } from "../src/lib/crypto";
import { prepareNoteContent } from "../src/lib/noteContent";

describe("Note content encryption transitions", () => {
  it("updates metadata without re-encrypting existing ciphertext", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    const updated = prepareNoteContent(existing, {});

    assert.strictEqual(updated, existing);
    assert.strictEqual(decryptText(updated.content, "current-passphrase"), "secret");
  });

  it("rotates an encrypted note passphrase exactly once", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    const updated = prepareNoteContent(existing, {
      currentPassphrase: "current-passphrase",
      newPassphrase: "replacement-passphrase",
    });

    assert.strictEqual(updated.isEncrypted, true);
    assert.strictEqual(decryptText(updated.content, "replacement-passphrase"), "secret");
    assert.throws(() => decryptText(updated.content, "current-passphrase"));
  });

  it("can remove encryption after verifying the current passphrase", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    const updated = prepareNoteContent(existing, {
      currentPassphrase: "current-passphrase",
      newPassphrase: null,
    });

    assert.deepStrictEqual(updated, { content: "secret", isEncrypted: false });
  });

  it("requires the current passphrase before replacing encrypted content", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    assert.throws(
      () => prepareNoteContent(existing, { content: "replacement" }),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 400
    );
  });

  it("can encrypt an existing plaintext note", () => {
    const updated = prepareNoteContent(
      { content: "plain", isEncrypted: false },
      { newPassphrase: "replacement-passphrase" }
    );

    assert.strictEqual(updated.isEncrypted, true);
    assert.strictEqual(decryptText(updated.content, "replacement-passphrase"), "plain");
  });
});

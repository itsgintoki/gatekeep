import { describe, it } from "node:test";
import assert from "node:assert";
import { generateSlug, encodeBase62, decodeBase62 } from "../src/lib/base62";

describe("Base62 Encoding & Slug Generation", () => {
  it("should generate random alphanumeric 7-character slugs", () => {
    const slug1 = generateSlug(7);
    const slug2 = generateSlug(7);

    assert.strictEqual(slug1.length, 7);
    assert.strictEqual(slug2.length, 7);
    assert.notStrictEqual(slug1, slug2);
    assert.match(slug1, /^[0-9a-zA-Z]{7}$/);
  });

  it("should bijectively encode and decode numbers without data loss", () => {
    const numbers = [0n, 1n, 61n, 62n, 123456789n, 9876543210123456789n];

    for (const num of numbers) {
      const encoded = encodeBase62(num);
      const decoded = decodeBase62(encoded);
      assert.strictEqual(decoded, num, `Failed roundtrip for ${num} -> ${encoded}`);
    }
  });
});

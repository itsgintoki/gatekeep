import { it, mock } from "node:test";
import assert from "node:assert/strict";
import { createSignedUrl, createStoragePath, deleteAsset, storageConfigured, uploadBuffer } from "../src/lib/storage";

it("uses private storage paths and expiring signed URLs without exposing the service key", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  assert.equal(storageConfigured(), false);
  await assert.rejects(createSignedUrl("file"), /configured/);
  process.env.SUPABASE_URL = "https://storage-unit.invalid";
  process.env.SUPABASE_SERVICE_KEY = "unit-test-secret";
  process.env.SUPABASE_STORAGE_BUCKET = "gatekeep";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const interceptor = mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (String(input).includes("/object/sign/")) return Response.json({ signedURL: "/object/sign/gatekeep/file?token=temporary" });
    return Response.json({ Key: "gatekeep/file" });
  });
  try {
    const path = createStoragePath("owner", "note");
    assert.match(path, /^owner\/note\/[0-9a-f-]{36}$/);
    await uploadBuffer(path, Buffer.from("test"), "application/pdf");
    const url = await createSignedUrl(path);
    await deleteAsset(path);
    assert.ok(!url.includes("unit-test-secret"));
    assert.match(url, /\/object\/sign\//);
    assert.equal(JSON.parse(String(requests[1].init?.body)).expiresIn, 900);
    assert.equal(requests[2].init?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)).prefixes, [path]);
    assert.ok(requests.every(request => !request.url.includes("/public/")));
  } finally { interceptor.mock.restore(); }
});

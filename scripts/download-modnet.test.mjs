import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { downloadModnet, FILE_ID, allowedDownloadUrl, streamWeights } from "./download-modnet.mjs";

const weights = Buffer.from("generated-download-test-only-not-a-real-model");
function sourceResponse(url) {
  if (url.endsWith("onnx/README.md")) return new Response(`/file/d/${FILE_ID}/view`);
  if (url.endsWith("README.md")) return new Response("The code, models, and demos are released under Apache License 2.0.");
  if (url.endsWith("LICENSE")) return new Response("Apache License Version 2.0");
  return new Response(weights, { headers: { "content-type": "application/octet-stream",
    "content-length": String(weights.length) } });
}
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "nanyi-official-download-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("redirects allow only HTTPS official Google hosts without credentials", () => {
  assert.ok(allowedDownloadUrl("https://drive.usercontent.google.com/download?id=test"));
  assert.ok(allowedDownloadUrl("https://doc-x.googleusercontent.com/download"));
  for (const value of ["http://drive.google.com/file", "https://evil.example/file",
    "https://googleusercontent.com.evil.example", "https://user:secret@drive.google.com/file"]) {
    assert.equal(allowedDownloadUrl(value), false);
  }
});

test("download snapshots source/license, streams/hash checks bytes, but never activates model", async (t) => {
  const workspace = await fixture(t);
  const result = await downloadModnet({ workspace, fetcher: async (url) => sourceResponse(url) });
  assert.equal(result.downloaded, true);
  assert.equal(result.runtimeValidated, false);
  assert.equal(result.productionEnabled, false);
  assert.deepEqual(await readFile(join(workspace, ".data/models/modnet.onnx")), weights);
  const record = JSON.parse(await readFile(join(workspace, ".data/model-materials", result.materialRunId, "record.json")));
  assert.equal(record.locallyComputedSha256, createHash("sha256").update(weights).digest("hex"));
  assert.equal(record.checkMethod, "automated_official_source_verification");
  assert.ok(!("reviewedBy" in record));
  await assert.rejects(readFile(join(workspace, ".data/local-model.json")));
});

test("HTML download failures preserve evidence and leave no fake weights or partials", async (t) => {
  const workspace = await fixture(t);
  await assert.rejects(downloadModnet({ workspace, fetcher: async (url) => {
    return url.includes("google.com") ? new Response("sign in private-secret", { headers: { "content-type": "text/html" } })
      : sourceResponse(url);
  } }), /MODEL_DOWNLOAD_UNAVAILABLE/);
  assert.deepEqual(await readdir(join(workspace, ".data/models")), []);
  const entries = await readdir(join(workspace, ".data/model-materials"));
  const data = await readFile(join(workspace, ".data/model-materials", entries[0], "record.json"), "utf8");
  assert.ok(!data.includes("private-secret"));
  assert.equal(JSON.parse(data).downloaded, false);
});

test("changed official file id or license declaration refuses download", async (t) => {
  const workspace = await fixture(t);
  await assert.rejects(downloadModnet({ workspace, fetcher: async (url) => {
    return url.endsWith("onnx/README.md") ? new Response("a different model") : sourceResponse(url);
  } }), /MODEL_SOURCE_CHANGED/);
  assert.deepEqual(await readdir(join(workspace, ".data/models")), []);
});

test("an unsafe redirect is rejected rather than sent to another provider", async (t) => {
  const workspace = await fixture(t);
  await assert.rejects(downloadModnet({ workspace, fetcher: async (url) => {
    return url.includes("google.com") ? new Response(null, { status: 302,
      headers: { location: "https://private.example/model" } }) : sourceResponse(url);
  } }), /UNTRUSTED_MODEL_REDIRECT/);
});

test("existing user weights are never replaced", async (t) => {
  const workspace = await fixture(t);
  await mkdir(join(workspace, ".data/models"), { recursive: true });
  await writeFile(join(workspace, ".data/models/modnet.onnx"), "user-owned");
  await assert.rejects(downloadModnet({ workspace, fetcher: async (url) => sourceResponse(url) }),
    /MODEL_WEIGHTS_ALREADY_EXIST/);
  assert.equal(await readFile(join(workspace, ".data/models/modnet.onnx"), "utf8"), "user-owned");
  assert.deepEqual(await readdir(join(workspace, ".data/models")), ["modnet.onnx"]);
});

test("stream budgets and truncated responses cannot pass as complete downloads", async (t) => {
  const workspace = await fixture(t);
  await assert.rejects(streamWeights(new Response(weights, { headers: {
    "content-type": "application/octet-stream", "content-length": "999"
  } }), join(workspace, "truncated"), { maxBytes: 1000 }), /MODEL_DOWNLOAD_INCOMPLETE/);
  await assert.rejects(streamWeights(new Response(weights, { headers: {
    "content-type": "application/octet-stream", "content-length": "999"
  } }), join(workspace, "oversized"), { maxBytes: 10 }), /MODEL_DOWNLOAD_TOO_LARGE/);
});

test("a private models directory cannot redirect the download outside data", async (t) => {
  const workspace = await fixture(t);
  await mkdir(join(workspace, ".data"));
  await mkdir(join(workspace, "outside"));
  await symlink(join(workspace, "outside"), join(workspace, ".data/models"));
  await assert.rejects(downloadModnet({ workspace, fetcher: async (url) => sourceResponse(url) }),
    /MODEL_DATA_ROOT_INVALID/);
});

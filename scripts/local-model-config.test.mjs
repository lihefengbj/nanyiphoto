import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { configureLocalModel } from "./local-model-config.mjs";
import { downloadModnet, FILE_ID } from "./download-modnet.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nanyi-local-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, ".data");
  await mkdir(data);
  const bytes = Buffer.from("test-only-not-real-model");
  await writeFile(join(data, "model.onnx"), bytes);
  const args = [
    "--weights", ".data/model.onnx", "--source", "https://example.invalid/test-weights",
    "--reviewer", "test-human-command-only", "--version", "test-v1"
  ];
  return { root, data, bytes, args };
}

test("no confirmation flag means no permission fields or config are created", async (t) => {
  const f = await fixture(t);
  await assert.rejects(configureLocalModel(f.args, f.root), /LOCAL_MODEL_REVIEW_REQUIRED/);
  await assert.rejects(stat(join(f.data, "local-model.json")));
});

test("explicit operator reviews write a private one-model record but do not claim runtime or production", async (t) => {
  const f = await fixture(t);
  const result = await configureLocalModel([...f.args, "--confirm-reviews"], f.root);
  const path = join(f.data, "local-model.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.model.weights.sha256, createHash("sha256").update(f.bytes).digest("hex"));
  assert.equal(config.model.weights.file, "model.onnx");
  assert.equal(config.model.codeReview.reviewedBy, "test-human-command-only");
  assert.equal(config.model.weights.review.confirmed, true);
  assert.equal(result.runtimeValidated, false);
  assert.equal(result.productionEnabled, false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes("test-human"));
});

test("existing user config is never overwritten", async (t) => {
  const f = await fixture(t);
  const path = join(f.data, "local-model.json");
  await writeFile(path, "user-owned");
  await assert.rejects(configureLocalModel([...f.args, "--confirm-reviews"], f.root), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "user-owned");
});

test("outside weights and symlinks cannot bypass private material boundaries", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside.onnx");
  await writeFile(outside, f.bytes);
  await symlink(outside, join(f.data, "linked.onnx"));
  const args = [...f.args, "--confirm-reviews"];
  args[1] = ".data/linked.onnx";
  await assert.rejects(configureLocalModel(args, f.root), /WEIGHTS_OUTSIDE_DATA_ROOT/);
});

test("unknown flags and unsafe source or version cannot create a reviewed record", async (t) => {
  const f = await fixture(t);
  for (const [index, value] of [
    [3, "http://example.invalid/weights"], [3, "https://example.invalid/?secret=private"],
    [7, "../private"]
  ]) {
    const args = [...f.args, "--confirm-reviews"];
    args[index] = value;
    await assert.rejects(configureLocalModel(args, f.root), /INVALID_LOCAL_MODEL_ARGUMENTS/);
  }
  await assert.rejects(configureLocalModel([...f.args, "--confirm-reviews", "--unknown"], f.root),
    /INVALID_LOCAL_MODEL_ARGUMENTS/);
});

async function privateFixture(t) {
  const f = await fixture(t);
  const result = await downloadModnet({ workspace: f.root, fetcher: async (url) => {
    if (url.endsWith("onnx/README.md")) return new Response(`/file/d/${FILE_ID}/view`);
    if (url.endsWith("README.md")) return new Response("The code, models, and demos");
    if (url.endsWith("LICENSE")) return new Response("Apache License Version 2.0");
    return new Response(f.bytes, { headers: { "content-type": "application/octet-stream" } });
  } });
  const receipt = `.data/model-materials/${result.materialRunId}/record.json`;
  return { ...f, receipt, args: ["--authorize-private-test", "--weights", ".data/models/modnet.onnx",
    "--download-record", receipt, "--version", "private-test-v1"] };
}

test("explicit private authorization records source evidence, not fabricated reviews", async (t) => {
  const f = await privateFixture(t);
  const result = await configureLocalModel(f.args, f.root);
  const config = JSON.parse(await readFile(join(f.data, "local-model.json"), "utf8"));
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.purpose, "private_device_test");
  assert.equal(config.privateTestAuthorization.authorized, true);
  assert.equal(config.formalReviewsCompleted, false);
  assert.ok(!("codeReview" in config.model));
  assert.ok(!("dependencyReview" in config.model));
  assert.ok(!("review" in config.model.weights));
  assert.ok(!JSON.stringify(config).includes("reviewedBy"));
  assert.equal(result.privateTestOnly, true);
  assert.equal(result.productionEnabled, false);
  assert.equal((await stat(join(f.data, "local-model.json"))).mode & 0o777, 0o600);
});

test("private authorization cannot be combined with formal attestation or another model", async (t) => {
  const f = await privateFixture(t);
  for (const extra of [["--confirm-reviews"], ["--reviewer", "invented-human"], ["--model", "rvm"]]) {
    await assert.rejects(configureLocalModel([...f.args, ...extra], f.root), /INVALID_LOCAL_MODEL_ARGUMENTS/);
  }
  await assert.rejects(stat(join(f.data, "local-model.json")));
});

test("private configuration rejects changed weights, source evidence and snapshots", async (t) => {
  const f = await privateFixture(t);
  const weights = join(f.data, "models/modnet.onnx");
  await writeFile(weights, "changed-weight");
  await assert.rejects(configureLocalModel(f.args, f.root), /LOCAL_MODEL_SOURCE_INVALID/);
  await writeFile(weights, f.bytes);
  await writeFile(join(f.root, f.receipt, "../LICENSE.txt"), "changed license snapshot");
  await assert.rejects(configureLocalModel(f.args, f.root), /LOCAL_MODEL_SOURCE_INVALID/);
});

test("private configuration refuses failed or nonofficial download receipts", async (t) => {
  const f = await privateFixture(t);
  const path = join(f.root, f.receipt);
  const original = JSON.parse(await readFile(path, "utf8"));
  for (const changes of [{ downloaded: false }, { codeCommit: "wrong" }, { source: "https://mirror.invalid" },
    { sourceVerified: false }, { checkMethod: "unverified" }]) {
    await writeFile(path, JSON.stringify({ ...original, ...changes }));
    await assert.rejects(configureLocalModel(f.args, f.root), /LOCAL_MODEL_SOURCE_INVALID/);
  }
  await assert.rejects(stat(join(f.data, "local-model.json")));
});

test("private configuration preserves an existing user config and rejects outside receipts", async (t) => {
  const f = await privateFixture(t);
  const outside = join(f.root, "outside.json");
  await writeFile(outside, await readFile(join(f.root, f.receipt)));
  const args = f.args.map((arg) => arg === f.receipt ? "outside.json" : arg);
  await assert.rejects(configureLocalModel(args, f.root), /LOCAL_MODEL_SOURCE_INVALID/);
  await writeFile(join(f.data, "local-model.json"), "user-owned");
  await assert.rejects(configureLocalModel(f.args, f.root), { code: "EEXIST" });
  assert.equal(await readFile(join(f.data, "local-model.json"), "utf8"), "user-owned");
});

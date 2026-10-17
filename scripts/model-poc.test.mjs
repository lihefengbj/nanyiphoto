import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PYTHON_BASELINE, supportedPythonVersion, validateManifest, verifyMaterials, latencySummary, summarizeMeasurements
} from "./model-poc.mjs";

const example = JSON.parse(readFileSync(new URL("../config/model-poc.example.json", import.meta.url), "utf8"));
const tags = [
  "straight_hair", "curly_hair", "fine_hair", "glasses",
  "varied_clothing", "backlit", "plain_background", "complex_background"
];
const TODAY = "2026-10-17";
const weights = Buffer.from("synthetic-weight-fixture-not-a-model");
const weightsHash = createHash("sha256").update(weights).digest("hex");
const review = () => ({ confirmed: true, reviewedBy: "test-reviewer", reviewedAt: TODAY, evidence: "test-only" });

function readyManifest() {
  const manifest = structuredClone(example);
  manifest.status = "ready";
  manifest.dataset.authorization = review();
  manifest.dataset.samples = Array.from({ length: 50 }, (_, index) => {
    const id = `sample-${String(index + 1).padStart(3, "0")}`;
    return { id, file: `${id}.png`, consentConfirmed: true, tags: [tags[index % tags.length]] };
  });
  manifest.models = [manifest.models[0]];
  Object.assign(manifest.models[0], {
    enabled: true, version: "test-fixture-v1", codeSource: "https://example.invalid/code",
    codeReview: review(), dependencyReview: review()
  });
  Object.assign(manifest.models[0].weights, {
    file: "../.data/models/test.onnx", sha256: weightsHash,
    source: "https://example.invalid/weights", review: review()
  });
  return manifest;
}

function measurements(manifest) {
  return {
    schemaVersion: 1,
    run: { ...manifest.run },
    models: manifest.models.filter((model) => model.enabled).map((model) => ({
      modelId: model.id, version: model.version, weightsSha256: model.weights.sha256,
      coldStartMs: 100, warmupMs: Array(manifest.run.warmupRuns).fill(20),
      peakRssBytes: 1024 * 1024, memoryMethod: "process_rusage",
      measurements: manifest.dataset.samples.flatMap((sample, index) =>
        Array.from({ length: manifest.run.repetitions }, (_, repetition) => ({
          sampleId: sample.id, repetition: repetition + 1, status: "succeeded",
          resultValidated: true, inferenceMs: index + 1, processingMs: index + 11
        })))
    }))
  };
}

test("runtime metadata distinguishes reference/CPU engines and strips nonallowlisted provider fields", () => {
  const manifest = readyManifest();
  const submitted = measurements(manifest);
  submitted.models[0].runtime = {
    engine: "onnx-reference", version: "1.20.0", numpyVersion: "2.5.4", onnxVersion: "1.20.0",
    foregroundKind: "model_rgb", privatePath: "/private/test-secret", providerError: "private-test-secret"
  };
  const summary = summarizeMeasurements(manifest, submitted);
  assert.equal(summary.models[0].runtime.engine, "onnx-reference");
  assert.equal(summary.models[0].runtime.foregroundKind, "model_rgb");
  assert.ok(!JSON.stringify(summary).includes("private"));
});

test("reference engine metadata cannot claim unconfigured threads or restored MODNet colors", () => {
  const manifest = readyManifest();
  const submitted = measurements(manifest);
  submitted.models[0].runtime = {
    engine: "onnx-reference", version: "1.20.0", numpyVersion: "2.5.4", onnxVersion: "1.20.0",
    foregroundKind: "model_rgb"
  };
  manifest.run.intraOpThreads = submitted.run.intraOpThreads = 2;
  assert.throws(() => summarizeMeasurements(manifest, submitted), /INVALID_MEASUREMENTS/);
  manifest.run.intraOpThreads = submitted.run.intraOpThreads = 1;
  manifest.models[0].id = submitted.models[0].modelId = "modnet";
  assert.throws(() => summarizeMeasurements(manifest, submitted), /INVALID_MEASUREMENTS/);
});

test("runtime metadata rejects unknown engines, arbitrary versions and invalid foreground declarations", () => {
  const manifest = readyManifest();
  for (const changes of [
    { engine: "unknown" }, { version: "/private/test-secret" }, { foregroundKind: "restored-without-evidence" },
    { numpyVersion: null }, { onnxVersion: "" }
  ]) {
    const submitted = measurements(manifest);
    submitted.models[0].runtime = {
      engine: "ort-cpu", version: "1.28.0", numpyVersion: "2.5.4", onnxVersion: "1.20.0",
      foregroundKind: "model_rgb", ...changes
    };
    assert.throws(() => summarizeMeasurements(manifest, submitted), /INVALID_MEASUREMENTS/);
  }
});

test("measurement resolutions are bounded and summarized without sample identifiers", () => {
  const manifest = readyManifest();
  const submitted = measurements(manifest);
  submitted.models[0].measurements.forEach((row) => Object.assign(row, {
    inputWidth: 32, inputHeight: 48, modelWidth: 64, modelHeight: 32
  }));
  const summary = summarizeMeasurements(manifest, submitted);
  assert.deepEqual(summary.models[0].resolutions, [
    { inputWidth: 32, inputHeight: 48, modelWidth: 64, modelHeight: 32, count: 50 }
  ]);
  submitted.models[0].measurements[0].modelWidth = 2049;
  assert.throws(() => summarizeMeasurements(manifest, submitted), /INVALID_MEASUREMENTS/);
  delete submitted.models[0].measurements[0].modelWidth;
  assert.throws(() => summarizeMeasurements(manifest, submitted), /INVALID_MEASUREMENTS/);
});

test("bundled model manifest is a disabled draft and cannot authorize model evaluation", () => {
  const result = validateManifest(example, { today: TODAY });
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.some((entry) => entry.code === "MANIFEST_IS_DRAFT"));
  assert.ok(result.blockers.some((entry) => entry.code === "NO_ENABLED_MODEL"));
  assert.ok(example.models.every((model) => model.enabled === false));
});

test("complete review, fifty authorized files and scenario coverage satisfy structural preparation gates", () => {
  assert.deepEqual(validateManifest(readyManifest(), { today: TODAY }), { errors: [], blockers: [] });
});

test("dataset authorization and every sample's consent remain mandatory", () => {
  const manifest = readyManifest();
  manifest.dataset.authorization.confirmed = false;
  manifest.dataset.samples[0].consentConfirmed = false;
  const result = validateManifest(manifest, { today: TODAY });
  assert.ok(result.blockers.some((entry) => entry.field === "dataset.authorization"));
  assert.ok(result.blockers.some((entry) => entry.code === "SAMPLE_NOT_AUTHORIZED"));
});

test("fewer than fifty samples or omitted appearance scenarios cannot pass preparation", () => {
  const manifest = readyManifest();
  manifest.dataset.samples.pop();
  manifest.dataset.samples.forEach((sample) => { sample.tags = ["straight_hair"]; });
  const result = validateManifest(manifest, { today: TODAY });
  assert.ok(result.blockers.some((entry) => entry.code === "DATASET_BELOW_50"));
  assert.equal(result.blockers.filter((entry) => entry.code === "SCENARIO_NOT_COVERED").length, 7);
});

test("sample and model duplicates are schema errors", () => {
  const manifest = readyManifest();
  manifest.dataset.samples[1] = structuredClone(manifest.dataset.samples[0]);
  manifest.models.push(structuredClone(manifest.models[0]));
  const errors = validateManifest(manifest, { today: TODAY }).errors;
  assert.ok(errors.some((entry) => entry.field === "dataset.samples.1.id"));
  assert.ok(errors.some((entry) => entry.field === "dataset.samples.1.file"));
  assert.ok(errors.some((entry) => entry.field === "models.1.id"));
});

test("source paths cannot contain traversal, raw names or network image URLs", () => {
  for (const file of ["../sample-001.png", "person-name.jpg", "https://example.invalid/image.png", "sample-001.gif"]) {
    const manifest = readyManifest();
    manifest.dataset.samples[0].file = file;
    assert.ok(validateManifest(manifest, { today: TODAY }).errors.some((entry) => entry.field.endsWith(".file")));
  }
});

test("model sources reject non-HTTPS, URL credentials, query strings and non-string values", () => {
  for (const value of [
    "http://example.invalid/code", "https://user:private@example.invalid/code",
    "https://:private@example.invalid/code", "https://example.invalid/code?key=private",
    ["https://example.invalid/code"], null
  ]) {
    const manifest = readyManifest();
    manifest.models[0].codeSource = value;
    assert.ok(validateManifest(manifest, { today: TODAY }).errors.some((entry) => entry.field.endsWith("codeSource")));
  }
});

test("model code, weights and dependency reviews are independently required", () => {
  for (const key of ["codeReview", "dependencyReview", "weights"]) {
    const manifest = readyManifest();
    const target = key === "weights" ? manifest.models[0].weights.review : manifest.models[0][key];
    target.confirmed = false;
    target.evidence = "";
    assert.ok(validateManifest(manifest, { today: TODAY }).blockers.some((entry) => entry.code === "REVIEW_NOT_CONFIRMED"));
  }
});

test("reviews reject impossible or future dates rather than declaring permission confirmed", () => {
  for (const reviewedAt of ["2026-02-30", "2026-10-18", "not-a-date"]) {
    const manifest = readyManifest();
    manifest.models[0].codeReview.reviewedAt = reviewedAt;
    assert.ok(validateManifest(manifest, { today: TODAY }).errors.length);
  }
});

test("weight hashes and versions are strict strings and cannot accept array coercion", () => {
  for (const value of ["not-a-hash", weightsHash.toUpperCase(), [weightsHash], null]) {
    const manifest = readyManifest();
    manifest.models[0].weights.sha256 = value;
    assert.ok(validateManifest(manifest, { today: TODAY }).errors.length);
  }
  const manifest = readyManifest();
  manifest.models[0].version = "";
  assert.ok(validateManifest(manifest, { today: TODAY }).blockers.some((entry) => entry.code === "MODEL_VERSION_MISSING"));
});

test("P0 run limits use supported Python family and serial concurrency, and cap thread, repetition and byte budgets", () => {
  for (const [key, value] of [
    ["pythonVersion", "3.15.0"], ["concurrency", 2], ["intraOpThreads", 0], ["interOpThreads", 65],
    ["warmupRuns", 0], ["repetitions", 21], ["maxInputBytes", 10485761], ["maxWeightsBytes", Infinity]
  ]) {
    const manifest = readyManifest();
    manifest.run[key] = value;
    assert.ok(validateManifest(manifest, { today: TODAY }).errors.some((entry) => entry.field === `run.${key}`));
  }
});

test("Python baseline is pinned for CI while recorded patch versions in the same minor family are accepted", () => {
  assert.equal(PYTHON_BASELINE, "3.14.5");
  assert.equal(example.run.pythonVersion, PYTHON_BASELINE);
  for (const value of ["3.14.0", "3.14.5", "3.14.6"]) assert.equal(supportedPythonVersion(value), true);
  for (const value of ["3.12.12", "3.13.0", "3.15.0", "3.14", "3.14.5rc1", "03.14.5", null, 3.14]) {
    assert.equal(supportedPythonVersion(value), false);
  }
  const manifest = readyManifest();
  manifest.run.pythonVersion = "3.14.6";
  assert.deepEqual(validateManifest(manifest, { today: TODAY }), { errors: [], blockers: [] });
});

test("release versions match between Node metadata, Python metadata and the API", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const pyproject = readFileSync(new URL("../backend/pyproject.toml", import.meta.url), "utf8");
  const api = readFileSync(new URL("../backend/nanyiphoto_api/main.py", import.meta.url), "utf8");
  assert.match(version, /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
  assert.equal(/^version = "([^"]+)"$/m.exec(pyproject)[1], version.replace("-rc.", "rc"));
  assert.ok(api.includes(`version="${version}",`));
});

test("package metadata and Ruff target remain consistent with the pinned Python family", () => {
  const pyproject = readFileSync(new URL("../backend/pyproject.toml", import.meta.url), "utf8");
  assert.match(pyproject, /requires-python\s*=\s*">=3\.14,<3\.15"/);
  assert.match(pyproject, /target-version\s*=\s*"py314"/);
});

test("malformed JSON shapes produce controlled schema errors", () => {
  for (const value of [null, 3, [], {}, { schemaVersion: 1, dataset: null, models: [null], run: null }]) {
    assert.ok(validateManifest(value, { today: TODAY }).errors.length);
  }
});

async function filesFixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "nanyi-poc-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = join(workspace, "config");
  const data = join(workspace, ".data");
  const samples = join(data, "poc-input");
  const models = join(data, "models");
  await Promise.all([mkdir(config), mkdir(samples, { recursive: true }), mkdir(models, { recursive: true })]);
  const manifest = readyManifest();
  await Promise.all(manifest.dataset.samples.map((sample) => writeFile(join(samples, sample.file), "not-an-image")));
  await writeFile(join(models, "test.onnx"), weights);
  return {
    workspace, config, data, samples, models, manifest,
    options: { workspaceRoot: workspace, manifestPath: join(config, "manifest.json") }
  };
}

test("material verification hashes only weights, reports no raw paths and explicitly leaves image/runtime checks pending", async (t) => {
  const f = await filesFixture(t);
  const result = await verifyMaterials(f.manifest, f.options);
  assert.equal(result.materialsReady, true);
  assert.equal(result.sampleCount, 50);
  assert.equal(result.models[0].weightsVerified, true);
  assert.equal(result.inferenceExecuted, false);
  assert.equal(result.imageDecodeValidated, false);
  assert.equal(result.runtimeValidated, false);
  assert.equal(result.productionEnabled, false);
  assert.ok(!JSON.stringify(result).includes(f.workspace));
  assert.ok(!JSON.stringify(result).includes(weightsHash));
});

test("draft verification returns blockers without accessing supplied local paths", async () => {
  const result = await verifyMaterials(example, { workspaceRoot: "/must-not-be-read" });
  assert.equal(result.materialsReady, false);
  assert.ok(!result.blockers.some((entry) => entry.code === "DATA_ROOT_UNAVAILABLE"));
});

test("weight hash mismatch never passes even when all review flags are confirmed", async (t) => {
  const f = await filesFixture(t);
  f.manifest.models[0].weights.sha256 = "a".repeat(64);
  const result = await verifyMaterials(f.manifest, f.options);
  assert.equal(result.materialsReady, false);
  assert.equal(result.models[0].weightsVerified, false);
  assert.ok(result.blockers.some((entry) => entry.code === "WEIGHTS_HASH_MISMATCH"));
});

test("missing or oversized sample and weight files are safely reported", async (t) => {
  const f = await filesFixture(t);
  await rm(join(f.samples, "sample-001.png"));
  f.manifest.run.maxInputBytes = 1;
  f.manifest.run.maxWeightsBytes = 1;
  const result = await verifyMaterials(f.manifest, f.options);
  assert.equal(result.materialsReady, false);
  assert.ok(result.blockers.some((entry) => entry.code === "SAMPLE_FILE_UNAVAILABLE"));
  assert.ok(result.blockers.some((entry) => entry.code === "WEIGHTS_FILE_UNAVAILABLE"));
  assert.ok(!JSON.stringify(result).includes(f.workspace));
});

test("symlinks cannot make an outside sample or weight file authorized", async (t) => {
  const f = await filesFixture(t);
  const outside = join(f.workspace, "outside.bin");
  await writeFile(outside, weights);
  await rm(join(f.models, "test.onnx"));
  await symlink(outside, join(f.models, "test.onnx"));
  await rm(join(f.samples, "sample-001.png"));
  await symlink(outside, join(f.samples, "sample-001.png"));
  const result = await verifyMaterials(f.manifest, f.options);
  assert.equal(result.materialsReady, false);
  assert.ok(result.blockers.some((entry) => entry.code === "SAMPLE_FILE_UNAVAILABLE"));
  assert.ok(result.blockers.some((entry) => entry.code === "WEIGHTS_FILE_UNAVAILABLE"));
});

test("the .data root itself cannot redirect verification outside the workspace", async (t) => {
  const f = await filesFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "nanyi-poc-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(f.data, { recursive: true, force: true });
  await symlink(outside, f.data);
  const result = await verifyMaterials(f.manifest, f.options);
  assert.equal(result.materialsReady, false);
  assert.ok(result.blockers.some((entry) => entry.code === "DATA_ROOT_UNAVAILABLE"));
});

test("hardlinks do not count the same sample file twice", async (t) => {
  const f = await filesFixture(t);
  await rm(join(f.samples, "sample-002.png"));
  await link(join(f.samples, "sample-001.png"), join(f.samples, "sample-002.png"));
  const result = await verifyMaterials(f.manifest, f.options);
  assert.equal(result.materialsReady, false);
  assert.equal(result.sampleCount, 49);
});

test("latency summary uses nearest-rank percentiles and never mutates submitted timing arrays", () => {
  const values = [50, 10, 40, 30, 20];
  assert.deepEqual(latencySummary(values), { count: 5, meanMs: 30, p50Ms: 30, p95Ms: 50, maxMs: 50 });
  assert.deepEqual(values, [50, 10, 40, 30, 20]);
  assert.equal(latencySummary([]), null);
});

test("invalid latency observations are rejected and zero is a valid measured duration", () => {
  for (const values of [[-1], [Infinity], [NaN], ["3"], [86400001], null]) {
    assert.throws(() => latencySummary(values), /INVALID_MEASUREMENTS/);
  }
  assert.equal(latencySummary([0]).p50Ms, 0);
});

test("submitted measurement summary does not claim to run inference or approve image quality", () => {
  const manifest = readyManifest();
  const summary = summarizeMeasurements(manifest, measurements(manifest));
  assert.equal(summary.kind, "submitted_measurement_summary");
  assert.equal(summary.inferenceExecutedByTool, false);
  assert.equal(summary.qualityApproval, false);
  assert.equal(summary.productionEnabled, false);
  assert.equal(summary.models[0].inference.p50Ms, 25);
  assert.equal(summary.models[0].inference.p95Ms, 48);
  assert.equal(summary.models[0].localProcessing.p50Ms, 35);
});

test("failures are counted separately and cannot be hidden by successful-latency statistics", () => {
  const manifest = readyManifest();
  const input = measurements(manifest);
  input.models[0].measurements[0] = {
    sampleId: "sample-001", repetition: 1, status: "failed", errorCode: "MODEL_FAILED"
  };
  const summary = summarizeMeasurements(manifest, input).models[0];
  assert.equal(summary.total, 50);
  assert.equal(summary.succeeded, 49);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failureRate, 0.02);
  assert.deepEqual(summary.failureCounts, { MODEL_FAILED: 1 });
});

test("an all-failed model reports null percentiles rather than fake zero latency", () => {
  const manifest = readyManifest();
  const input = measurements(manifest);
  input.models[0].measurements.forEach((row) => {
    row.status = "failed";
    row.errorCode = "TIMEOUT";
  });
  const summary = summarizeMeasurements(manifest, input).models[0];
  assert.equal(summary.failed, 50);
  assert.equal(summary.inference, null);
  assert.equal(summary.localProcessing, null);
});

test("all samples and repetitions are required so submitted measurements cannot cherry-pick successes", () => {
  const manifest = readyManifest();
  manifest.run.repetitions = 2;
  const input = measurements(manifest);
  assert.equal(summarizeMeasurements(manifest, input).models[0].total, 100);
  input.models[0].measurements.pop();
  assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
});

test("duplicate sample measurements and unknown samples cannot masquerade as complete coverage", () => {
  const manifest = readyManifest();
  const input = measurements(manifest);
  input.models[0].measurements[1] = structuredClone(input.models[0].measurements[0]);
  assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
  input.models[0].measurements[1].sampleId = "sample-999";
  assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
});

test("submitted run configuration, version and weight hash must match the reviewed manifest", () => {
  const manifest = readyManifest();
  for (const mutate of [
    (input) => { input.run.concurrency = 2; },
    (input) => { input.run.pythonVersion = "3.14.0"; },
    (input) => { input.models[0].version = "different"; },
    (input) => { input.models[0].weightsSha256 = "b".repeat(64); },
    (input) => { input.models[0].warmupMs = []; }
  ]) {
    const input = measurements(manifest);
    mutate(input);
    assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
  }
});

test("unvalidated outputs, reversed durations and unknown free-form errors are rejected", () => {
  const manifest = readyManifest();
  for (const mutate of [
    (row) => { row.resultValidated = false; },
    (row) => { row.inferenceMs = Infinity; },
    (row) => { row.processingMs = 0; },
    (row) => { row.status = "failed"; row.errorCode = "RAW-private-error"; }
  ]) {
    const input = measurements(manifest);
    mutate(input.models[0].measurements[0]);
    assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
  }
});

test("missing peak memory or unrecognized memory provenance cannot be reported as measured", () => {
  const manifest = readyManifest();
  for (const mutate of [
    (result) => { result.peakRssBytes = null; },
    (result) => { result.memoryMethod = "estimated"; },
    (result) => { result.peakRssBytes = 0; }
  ]) {
    const input = measurements(manifest);
    mutate(input.models[0]);
    assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
  }
});

test("summary only returns whitelisted aggregates, excluding identities, photos, raw errors and paths", () => {
  const manifest = readyManifest();
  const input = measurements(manifest);
  const secret = "RAW-private-photo-token-path";
  input.owner = secret;
  input.run.rawEnvironment = secret;
  input.models[0].rawOutput = secret;
  input.models[0].measurements[0].path = secret;
  input.models[0].measurements[0].photoHash = secret;
  const summary = summarizeMeasurements(manifest, input);
  assert.ok(!JSON.stringify(summary).includes(secret));
  assert.ok(!JSON.stringify(summary).includes("sample-001"));
});

test("disabled or duplicate model measurement reports are rejected", () => {
  const manifest = readyManifest();
  const input = measurements(manifest);
  input.models.push(structuredClone(input.models[0]));
  assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
  input.models.pop();
  input.models[0].modelId = "not-enabled";
  assert.throws(() => summarizeMeasurements(manifest, input), /INVALID_MEASUREMENTS/);
});

test("unreviewed manifests cannot turn timing fixtures into approved benchmark results", () => {
  assert.throws(() => summarizeMeasurements(example, {}), /MATERIAL_REVIEW_INCOMPLETE/);
});

const cliPath = fileURLToPath(new URL("./model-poc.mjs", import.meta.url));
function cli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", timeout: 10000 });
}

test("CLI structure check accepts disabled example without running or enabling a model", () => {
  const result = cli(["--check"]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.inferenceExecuted, false);
  assert.equal(output.productionEnabled, false);
  assert.ok(output.blockers.length > 0);
});

test("CLI verification blocks the draft with exit one and never exposes private local paths", () => {
  const result = cli(["--verify"]);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.materialsReady, false);
  assert.ok(!result.stdout.includes(resolve(".")));
});

test("CLI rejects unsupported modes, missing measurement inputs and extra arguments", () => {
  for (const args of [[], ["--run"], ["--summarize"], ["--check", "first", "second"]]) {
    const result = cli(args);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENTS");
  }
});

test("CLI missing file errors are fixed codes rather than raw exception paths", () => {
  const result = cli(["--check", "/RAW-private-input-not-present.json"]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "INPUT_UNAVAILABLE");
  assert.ok(!result.stdout.includes("RAW-private"));
});

test("CLI rejects malformed and oversized JSON without printing its content", async (t) => {
  const f = await filesFixture(t);
  const bad = join(f.config, "bad.json");
  await writeFile(bad, "{ RAW-private");
  const result = cli(["--check", bad]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_JSON_FILE");
  assert.ok(!result.stdout.includes("RAW-private"));
  await writeFile(bad, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  const large = cli(["--check", bad]);
  assert.equal(large.status, 2);
  assert.equal(JSON.parse(large.stdout).error.code, "INVALID_JSON_FILE");
});

test("CLI can summarize submitted complete measurements while explicitly reporting no inference execution", async (t) => {
  const f = await filesFixture(t);
  const report = join(f.config, "measurements.json");
  await writeFile(f.options.manifestPath, JSON.stringify(f.manifest));
  await writeFile(report, JSON.stringify(measurements(f.manifest)));
  const result = cli(["--summarize", f.options.manifestPath, report]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).inferenceExecutedByTool, false);
});

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PYTHON_BASELINE = readFileSync(resolve(ROOT, ".python-version"), "utf8").trim();
const DEFAULT_MANIFEST = resolve(ROOT, "config/model-poc.example.json");
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const TAGS = [
  "straight_hair", "curly_hair", "fine_hair", "glasses",
  "varied_clothing", "backlit", "plain_background", "complex_background"
];
const ERRORS = new Set([
  "MODEL_FAILED", "INVALID_MODEL_RESULT", "INVALID_FOREGROUND_ALPHA",
  "INPUT_CHANGED", "MODEL_RESULT_TOO_LARGE", "TIMEOUT"
]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const slug = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const sampleId = (value) => typeof value === "string" && /^sample-\d{3,6}$/.test(value);
const version = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value);
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 500;
const boundedTime = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86400000;
const issue = (code, field) => ({ code, field });

export function supportedPythonVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  const parts = value.split(".");
  const baseline = PYTHON_BASELINE.split(".");
  // Record the actual patch version; accept the supported minor family instead
  // of confusing the reproducible CI pin with a hard runtime compatibility gate.
  return parts[0] === baseline[0] && parts[1] === baseline[1];
}

function date(value, today) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value && value <= today;
}

function source(value) {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !/^https:\/\/[^/?#]*@/i.test(value) && !url.search;
  } catch { return false; }
}

function localPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 500
    && !value.includes("\0") && !/^[a-z]+:\/\//i.test(value);
}

// Confirmation fields are human attestations. They do not prove legal permission.
export function validateManifest(manifest, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  const blockers = [];
  const invalid = (condition, field) => { if (!condition) errors.push(issue("INVALID_MANIFEST", field)); };
  const requireReview = (review, field, required) => {
    invalid(object(review), field);
    if (!object(review)) return;
    invalid(typeof review.confirmed === "boolean", `${field}.confirmed`);
    invalid(typeof review.reviewedBy === "string" && review.reviewedBy.length <= 200, `${field}.reviewedBy`);
    invalid(review.reviewedAt === null || date(review.reviewedAt, today), `${field}.reviewedAt`);
    invalid(typeof review.evidence === "string" && review.evidence.length <= 500, `${field}.evidence`);
    if (required && !(review.confirmed && text(review.reviewedBy) && date(review.reviewedAt, today)
        && text(review.evidence))) blockers.push(issue("REVIEW_NOT_CONFIRMED", field));
  };
  if (!object(manifest)) return { errors: [issue("INVALID_MANIFEST", "manifest")], blockers };
  invalid(manifest.schemaVersion === 1, "schemaVersion");
  invalid(["draft", "ready"].includes(manifest.status), "status");
  if (manifest.status !== "ready") blockers.push(issue("MANIFEST_IS_DRAFT", "status"));
  invalid(object(manifest.dataset), "dataset");
  const samples = object(manifest.dataset) && manifest.dataset.samples;
  if (object(manifest.dataset)) {
    invalid(localPath(manifest.dataset.root), "dataset.root");
    requireReview(manifest.dataset.authorization, "dataset.authorization", true);
  }
  invalid(Array.isArray(samples) && samples.length >= 1 && samples.length <= 500, "dataset.samples");
  const seenIds = new Set();
  const seenFiles = new Set();
  const coverage = new Set();
  if (Array.isArray(samples) && samples.length <= 500) {
    if (samples.length < 50) blockers.push(issue("DATASET_BELOW_50", "dataset.samples"));
    samples.forEach((sample, index) => {
      const field = `dataset.samples.${index}`;
      if (!object(sample)) { invalid(false, field); return; }
      invalid(sampleId(sample.id) && !seenIds.has(sample.id), `${field}.id`);
      seenIds.add(sample.id);
      invalid(typeof sample.file === "string" && /^sample-\d{3,6}\.(png|jpe?g)$/.test(sample.file)
        && !seenFiles.has(sample.file), `${field}.file`);
      seenFiles.add(sample.file);
      invalid(typeof sample.consentConfirmed === "boolean", `${field}.consentConfirmed`);
      if (sample.consentConfirmed !== true) blockers.push(issue("SAMPLE_NOT_AUTHORIZED", field));
      invalid(Array.isArray(sample.tags) && sample.tags.length >= 1 && sample.tags.length <= TAGS.length
        && new Set(sample.tags).size === sample.tags.length && sample.tags.every((tag) => TAGS.includes(tag)),
      `${field}.tags`);
      if (Array.isArray(sample.tags)) sample.tags.forEach((tag) => { if (TAGS.includes(tag)) coverage.add(tag); });
    });
    for (const tag of TAGS) if (!coverage.has(tag)) blockers.push(issue("SCENARIO_NOT_COVERED", `coverage.${tag}`));
  }
  invalid(Array.isArray(manifest.models) && manifest.models.length >= 1 && manifest.models.length <= 10, "models");
  const seenModels = new Set();
  let enabledCount = 0;
  if (Array.isArray(manifest.models) && manifest.models.length <= 10) manifest.models.forEach((model, index) => {
    const field = `models.${index}`;
    if (!object(model)) { invalid(false, field); return; }
    invalid(slug(model.id) && !seenModels.has(model.id), `${field}.id`);
    seenModels.add(model.id);
    invalid(typeof model.enabled === "boolean", `${field}.enabled`);
    invalid(model.version === "" || version(model.version), `${field}.version`);
    invalid(model.codeSource === "" || source(model.codeSource), `${field}.codeSource`);
    if (model.enabled === true) {
      enabledCount++;
      if (!version(model.version)) blockers.push(issue("MODEL_VERSION_MISSING", `${field}.version`));
      if (!source(model.codeSource)) blockers.push(issue("MODEL_SOURCE_MISSING", `${field}.codeSource`));
    }
    requireReview(model.codeReview, `${field}.codeReview`, model.enabled === true);
    requireReview(model.dependencyReview, `${field}.dependencyReview`, model.enabled === true);
    invalid(object(model.weights), `${field}.weights`);
    if (object(model.weights)) {
      invalid(localPath(model.weights.file), `${field}.weights.file`);
      const hashPresent = typeof model.weights.sha256 === "string" && /^[a-f0-9]{64}$/.test(model.weights.sha256);
      invalid(model.weights.sha256 === "" || hashPresent, `${field}.weights.sha256`);
      invalid(model.weights.source === "" || source(model.weights.source), `${field}.weights.source`);
      requireReview(model.weights.review, `${field}.weights.review`, model.enabled === true);
      if (model.enabled === true && !hashPresent) {
        blockers.push(issue("WEIGHTS_HASH_MISSING", `${field}.weights.sha256`));
      }
      if (model.enabled === true && !source(model.weights.source)) {
        blockers.push(issue("WEIGHTS_SOURCE_MISSING", `${field}.weights.source`));
      }
    }
  });
  if (!enabledCount) blockers.push(issue("NO_ENABLED_MODEL", "models"));
  invalid(object(manifest.run), "run");
  if (object(manifest.run)) {
    invalid(supportedPythonVersion(manifest.run.pythonVersion), "run.pythonVersion");
    // P0 starts at concurrency 1. Future parallel experiments need a new schema.
    invalid(manifest.run.concurrency === 1, "run.concurrency");
    for (const key of ["intraOpThreads", "interOpThreads"]) invalid(positive(manifest.run[key], 64), `run.${key}`);
    invalid(positive(manifest.run.warmupRuns, 20), "run.warmupRuns");
    invalid(positive(manifest.run.repetitions, 20), "run.repetitions");
    invalid(positive(manifest.run.maxInputBytes, 10 * 1024 * 1024), "run.maxInputBytes");
    invalid(positive(manifest.run.maxWeightsBytes, 10 * 1024 ** 3), "run.maxWeightsBytes");
  }
  return { errors, blockers };
}

function inside(root, filename) {
  const path = relative(root, filename);
  return path !== "" && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && path !== ".." && !isAbsolute(path);
}

async function containedFile(base, filename, maxBytes) {
  const path = await realpath(filename);
  if (!inside(base, path)) throw new Error("FILE_OUTSIDE_DATA_ROOT");
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new Error("FILE_SIZE_INVALID");
  return { path, size: info.size, identity: info.ino ? `${info.dev}:${info.ino}` : path };
}

export async function verifyMaterials(manifest, { manifestPath = DEFAULT_MANIFEST, workspaceRoot = ROOT } = {}) {
  const validation = validateManifest(manifest);
  const blockers = [...validation.blockers];
  const base = {
    kind: "model_poc_material_check", schemaVersion: 1, materialsReady: false,
    inferenceExecuted: false, imageDecodeValidated: false, runtimeValidated: false,
    productionEnabled: false, errors: validation.errors, blockers, sampleCount: 0, models: []
  };
  if (validation.errors.length || blockers.length) return base;
  let dataRoot;
  let datasetRoot;
  try {
    // Resolving .data itself must not turn a symlink outside the project into an allowed root.
    const workspace = await realpath(workspaceRoot);
    dataRoot = await realpath(resolve(workspaceRoot, ".data"));
    if (!inside(workspace, dataRoot)) throw new Error("FILE_OUTSIDE_DATA_ROOT");
    datasetRoot = await realpath(resolve(dirname(manifestPath), manifest.dataset.root));
    if (!inside(dataRoot, datasetRoot)) throw new Error("FILE_OUTSIDE_DATA_ROOT");
  } catch {
    blockers.push(issue("DATA_ROOT_UNAVAILABLE", "dataset.root"));
    return base;
  }
  const paths = new Set();
  for (let index = 0; index < manifest.dataset.samples.length; index++) {
    try {
      const file = await containedFile(datasetRoot, resolve(datasetRoot, manifest.dataset.samples[index].file),
        manifest.run.maxInputBytes);
      if (paths.has(file.identity)) throw new Error("DUPLICATE_SAMPLE_FILE");
      paths.add(file.identity);
      // No photo content is read or hashed here. Decoder/orientation/pixels are a separate gate.
      base.sampleCount++;
    } catch { blockers.push(issue("SAMPLE_FILE_UNAVAILABLE", `dataset.samples.${index}`)); }
  }
  for (let index = 0; index < manifest.models.length; index++) {
    const model = manifest.models[index];
    if (!model.enabled) continue;
    const result = { modelId: model.id, version: model.version, weightsVerified: false };
    base.models.push(result);
    try {
      const file = await containedFile(dataRoot, resolve(dirname(manifestPath), model.weights.file),
        manifest.run.maxWeightsBytes);
      const hash = createHash("sha256");
      // A bounded stream avoids loading multi-gigabyte weights into memory.
      let bytes = 0;
      for await (const chunk of createReadStream(file.path, { highWaterMark: 64 * 1024 })) {
        bytes += chunk.length;
        if (bytes > manifest.run.maxWeightsBytes) throw new Error("FILE_SIZE_INVALID");
        hash.update(chunk);
      }
      if (bytes !== file.size || hash.digest("hex") !== model.weights.sha256) {
        blockers.push(issue("WEIGHTS_HASH_MISMATCH", `models.${index}.weights`));
      } else {
        result.weightsVerified = true;
        result.weightsBytes = bytes;
      }
    } catch { blockers.push(issue("WEIGHTS_FILE_UNAVAILABLE", `models.${index}.weights`)); }
  }
  base.materialsReady = blockers.length === 0;
  return base;
}

const round = (value) => Math.round(value * 1000) / 1000;
export function latencySummary(values) {
  if (!Array.isArray(values) || values.some((value) => !boundedTime(value))) throw new Error("INVALID_MEASUREMENTS");
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
  return {
    count: values.length, meanMs: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: round(percentile(0.5)), p95Ms: round(percentile(0.95)), maxMs: round(sorted.at(-1))
  };
}

export function summarizeMeasurements(manifest, submitted) {
  const validation = validateManifest(manifest);
  if (validation.errors.length || validation.blockers.length) throw new Error("MATERIAL_REVIEW_INCOMPLETE");
  const fail = (condition) => { if (!condition) throw new Error("INVALID_MEASUREMENTS"); };
  fail(object(submitted) && submitted.schemaVersion === 1 && object(submitted.run));
  const run = submitted.run;
  for (const key of ["pythonVersion", "concurrency", "intraOpThreads", "interOpThreads", "warmupRuns", "repetitions"]) {
    fail(run[key] === manifest.run[key]);
  }
  fail(Array.isArray(submitted.models) && submitted.models.length <= 10);
  const enabled = manifest.models.filter((model) => model.enabled);
  fail(submitted.models.length === enabled.length);
  const sampleIds = new Set(manifest.dataset.samples.map((sample) => sample.id));
  const seenModels = new Set();
  const summaries = [];
  for (const result of submitted.models) {
    fail(object(result) && slug(result.modelId) && !seenModels.has(result.modelId));
    seenModels.add(result.modelId);
    const model = enabled.find((candidate) => candidate.id === result.modelId);
    fail(model && result.version === model.version && result.weightsSha256 === model.weights.sha256);
    fail(boundedTime(result.coldStartMs) && Array.isArray(result.warmupMs)
      && result.warmupMs.length === manifest.run.warmupRuns && result.warmupMs.every(boundedTime));
    fail(positive(result.peakRssBytes, 1024 ** 4));
    fail(["process_rusage", "sampled_process_rss"].includes(result.memoryMethod));
    let runtime;
    if (result.runtime !== undefined) {
      const info = result.runtime;
      fail(object(info) && ["ort-cpu", "onnx-reference"].includes(info.engine)
        && version(info.version) && version(info.numpyVersion) && version(info.onnxVersion)
        && ["model_rgb", "source_rgb"].includes(info.foregroundKind));
      fail(info.engine !== "onnx-reference" || (run.intraOpThreads === 1 && run.interOpThreads === 1));
      fail(model.id !== "rvm" || info.foregroundKind === "model_rgb");
      fail(model.id !== "modnet" || info.foregroundKind === "source_rgb");
      runtime = {
        engine: info.engine, version: info.version, numpyVersion: info.numpyVersion,
        onnxVersion: info.onnxVersion, foregroundKind: info.foregroundKind
      };
      if (info.platform !== undefined || info.machine !== undefined) {
        fail(["darwin", "linux"].includes(info.platform) && ["x86_64", "arm64", "aarch64"].includes(info.machine));
        runtime.platform = info.platform;
        runtime.machine = info.machine;
      }
    }
    fail(Array.isArray(result.measurements)
      && result.measurements.length === sampleIds.size * manifest.run.repetitions);
    const seenRows = new Set();
    const inference = [];
    const processing = [];
    const failures = {};
    const resolutions = new Map();
    for (const row of result.measurements) {
      fail(object(row) && sampleIds.has(row.sampleId) && positive(row.repetition, manifest.run.repetitions));
      const key = `${row.sampleId}:${row.repetition}`;
      fail(!seenRows.has(key));
      seenRows.add(key);
      fail(["succeeded", "failed"].includes(row.status));
      if (row.status === "succeeded") {
        fail(row.resultValidated === true && boundedTime(row.inferenceMs) && boundedTime(row.processingMs)
          && row.processingMs >= row.inferenceMs);
        inference.push(row.inferenceMs);
        processing.push(row.processingMs);
        const dimensions = ["inputWidth", "inputHeight", "modelWidth", "modelHeight"];
        if (dimensions.some((key) => row[key] !== undefined)) {
          fail(dimensions.every((key) => positive(row[key], key.startsWith("model") ? 2048 : 4 * 1024 * 1024))
            && row.inputWidth * row.inputHeight <= 4 * 1024 * 1024
            && row.modelWidth * row.modelHeight <= 4 * 1024 * 1024);
          const key = dimensions.map((name) => row[name]).join(":");
          const entry = resolutions.get(key) || {
            inputWidth: row.inputWidth, inputHeight: row.inputHeight,
            modelWidth: row.modelWidth, modelHeight: row.modelHeight, count: 0
          };
          entry.count++;
          resolutions.set(key, entry);
        }
      } else {
        fail(ERRORS.has(row.errorCode));
        failures[row.errorCode] = (failures[row.errorCode] || 0) + 1;
      }
    }
    summaries.push({
      modelId: model.id, version: model.version, coldStartMs: round(result.coldStartMs),
      ...(runtime ? { runtime } : {}),
      ...(resolutions.size ? { resolutions: Array.from(resolutions.values()) } : {}),
      warmup: latencySummary(result.warmupMs), peakRssBytes: result.peakRssBytes,
      memoryMethod: result.memoryMethod, total: result.measurements.length, succeeded: inference.length,
      failed: result.measurements.length - inference.length,
      failureRate: Math.round((result.measurements.length - inference.length) / result.measurements.length * 1e6) / 1e6,
      failureCounts: failures, inference: latencySummary(inference), localProcessing: latencySummary(processing)
    });
  }
  // Only whitelisted aggregate fields leave this boundary: no paths, photo hashes,
  // raw exceptions, credentials, input images, or arbitrary provider metadata.
  return {
    schemaVersion: 1, kind: "submitted_measurement_summary", inferenceExecutedByTool: false,
    percentileMethod: "nearest_rank", photoCount: sampleIds.size, run: {
      pythonVersion: run.pythonVersion, concurrency: run.concurrency,
      intraOpThreads: run.intraOpThreads, interOpThreads: run.interOpThreads,
      warmupRuns: run.warmupRuns, repetitions: run.repetitions
    },
    productionEnabled: false, qualityApproval: false, models: summaries
  };
}

async function readJson(filename) {
  const info = await stat(filename);
  if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new Error("INVALID_JSON_FILE");
  const data = await readFile(filename);
  if (data.length > MAX_JSON_BYTES) throw new Error("INVALID_JSON_FILE");
  try { return JSON.parse(data.toString("utf8")); } catch { throw new Error("INVALID_JSON_FILE"); }
}

export async function main(args) {
  const [mode, manifestArg, measurementsArg, ...extra] = args;
  if (!["--check", "--verify", "--summarize"].includes(mode) || extra.length
      || (mode !== "--summarize" && measurementsArg) || (mode === "--summarize" && !measurementsArg)) {
    console.log(JSON.stringify({ error: { code: "INVALID_ARGUMENTS" } }));
    return 2;
  }
  try {
    const manifestPath = resolve(manifestArg || DEFAULT_MANIFEST);
    const manifest = await readJson(manifestPath);
    let result;
    let exitCode = 0;
    if (mode === "--check") {
      const validation = validateManifest(manifest);
      result = { kind: "model_poc_manifest_check", ...validation, inferenceExecuted: false, productionEnabled: false };
      exitCode = validation.errors.length ? 2 : 0;
    } else if (mode === "--verify") {
      result = await verifyMaterials(manifest, { manifestPath });
      exitCode = result.materialsReady ? 0 : 1;
    } else {
      result = summarizeMeasurements(manifest, await readJson(resolve(measurementsArg)));
    }
    console.log(JSON.stringify(result, null, 2));
    return exitCode;
  } catch (error) {
    const code = ["MATERIAL_REVIEW_INCOMPLETE", "INVALID_MEASUREMENTS", "INVALID_JSON_FILE"].includes(error.message)
      ? error.message : "INPUT_UNAVAILABLE";
    console.log(JSON.stringify({ error: { code }, inferenceExecuted: false, productionEnabled: false }));
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}

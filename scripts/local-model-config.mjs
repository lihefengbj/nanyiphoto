import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath, stat, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMIT, SOURCE } from "./download-modnet.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRIVATE_SCOPE = "private_authorized_photo_device_tests_only";

async function sourceReceipt(name, dataRoot) {
  const path = await realpath(resolve(dataRoot, "..", name));
  if (!inside(resolve(dataRoot, "model-materials"), path)) throw new Error("LOCAL_MODEL_SOURCE_INVALID");
  const bounded = async (file) => {
    const actual = await realpath(file);
    if (!inside(dataRoot, actual)) throw new Error("LOCAL_MODEL_SOURCE_INVALID");
    if ((await stat(actual)).size > 65536) throw new Error("LOCAL_MODEL_SOURCE_INVALID");
    const data = await readFile(actual);
    if (data.length > 65536) throw new Error("LOCAL_MODEL_SOURCE_INVALID");
    return data;
  };
  const bytes = await bounded(path);
  const record = JSON.parse(bytes);
  if (record.schemaVersion !== 1 || record.modelId !== "modnet" || record.codeCommit !== COMMIT
      || record.source !== SOURCE || record.sourceVerified !== true || record.downloaded !== true
      || record.productionEnabled !== false || record.licenseIdentifier !== "Apache-2.0"
      || record.checkMethod !== "automated_official_source_verification"
      || !/^[a-f0-9]{64}$/.test(record.locallyComputedSha256 || "")
      || !Number.isInteger(record.bytes) || record.bytes < 1 || record.bytes > 512 * 1024 * 1024) {
    throw new Error("LOCAL_MODEL_SOURCE_INVALID");
  }
  for (const [name, field] of [["README.md", "readmeSha256"], ["ONNX-README.md", "onnxReadmeSha256"],
    ["LICENSE.txt", "licenseSha256"]]) {
    const content = await bounded(resolve(path, "..", name));
    if (createHash("sha256").update(content).digest("hex") !== record[field]) throw new Error("LOCAL_MODEL_SOURCE_INVALID");
  }
  return { record, path: relative(dataRoot, path), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function inside(root, path) {
  const name = relative(root, path);
  return name && name !== ".." && !name.startsWith("../") && !isAbsolute(name);
}

export async function configureLocalModel(args, workspace = ROOT) {
  const values = {};
  let confirmed = false;
  let privateTest = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--confirm-reviews" && !confirmed) { confirmed = true; continue; }
    if (key === "--authorize-private-test" && !privateTest) { privateTest = true; continue; }
    if (!["--weights", "--source", "--reviewer", "--version", "--model", "--download-record"].includes(key) || values[key]
        || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("INVALID_LOCAL_MODEL_ARGUMENTS");
    values[key] = args[++index];
  }
  if (!confirmed && !privateTest) throw new Error("LOCAL_MODEL_REVIEW_REQUIRED");
  if ((confirmed && privateTest) || (privateTest && (values["--reviewer"] || !values["--download-record"]))
      || (!privateTest && values["--download-record"])) throw new Error("INVALID_LOCAL_MODEL_ARGUMENTS");
  const modelId = values["--model"] || "modnet";
  if (!["modnet", "rvm"].includes(modelId) || !values["--weights"]
      || (privateTest && modelId !== "modnet")
      || (!privateTest && (!values["--source"] || !values["--reviewer"]
        || !values["--reviewer"].trim() || values["--reviewer"].length > 200))
      || !/^[A-Za-z0-9._-]{1,100}$/.test(values["--version"] || "")) throw new Error("INVALID_LOCAL_MODEL_ARGUMENTS");
  const source = new URL(values["--source"] || SOURCE);
  if (source.protocol !== "https:" || source.username || source.password || source.search) {
    throw new Error("INVALID_LOCAL_MODEL_ARGUMENTS");
  }
  const root = await realpath(workspace);
  const dataRoot = await realpath(resolve(root, ".data"));
  const weights = await realpath(resolve(root, values["--weights"]));
  if (!inside(root, dataRoot) || !inside(dataRoot, weights)) throw new Error("WEIGHTS_OUTSIDE_DATA_ROOT");
  const info = await stat(weights);
  if (!info.isFile() || info.size < 1 || info.size > 512 * 1024 * 1024) throw new Error("MODEL_WEIGHTS_TOO_LARGE");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(weights, { highWaterMark: 65536 })) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) throw new Error("MODEL_WEIGHTS_TOO_LARGE");
    hash.update(chunk);
  }
  if (bytes !== info.size) throw new Error("INPUT_CHANGED");
  const digest = hash.digest("hex");
  const reviewedAt = new Date().toISOString().slice(0, 10);
  const review = (evidence) => ({
    confirmed: true, reviewedBy: values["--reviewer"], reviewedAt, evidence
  });
  const codeSource = modelId === "modnet"
    ? "https://github.com/ZHKKKe/MODNet" : "https://github.com/PeterL1n/RobustVideoMatting";
  let record = {
    schemaVersion: 1,
    model: {
      id: modelId, enabled: true, version: values["--version"], codeSource,
      codeReview: review("Operator explicitly confirmed code-license review via --confirm-reviews."),
      dependencyReview: review("Operator explicitly confirmed dependency review via --confirm-reviews."),
      weights: {
        file: relative(dataRoot, weights), sha256: digest, source: source.href,
        review: review("Operator explicitly confirmed this weight-source/license review via --confirm-reviews.")
      }
    }
  };
  if (privateTest) {
    const receipt = await sourceReceipt(values["--download-record"], dataRoot);
    if (receipt.record.locallyComputedSha256 !== digest || receipt.record.bytes !== bytes
        || source.href !== SOURCE) throw new Error("LOCAL_MODEL_SOURCE_INVALID");
    record = {
      schemaVersion: 2, purpose: "private_device_test", formalReviewsCompleted: false,
      privateTestAuthorization: {
        authorized: true, authorizedAt: reviewedAt, scope: PRIVATE_SCOPE,
        basis: "explicit_private_test_command"
      },
      sourceVerification: { receipt: receipt.path, sha256: receipt.sha256 },
      model: {
        id: "modnet", enabled: true, version: values["--version"],
        codeSource: `https://github.com/ZHKKKe/MODNet/tree/${COMMIT}`,
        weights: { file: relative(dataRoot, weights), sha256: digest, source: SOURCE }
      }
    };
  }
  // Explicit HUMAN command attests reviews; never run this flag on the user's
  // behalf to manufacture permission. The separate private flag records only
  // explicitly authorized device tests + automated source evidence, NOT reviews.
  // Do not replace a user's existing config.
  const handle = await open(resolve(dataRoot, "local-model.json"), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2)); }
  finally { await handle.close(); }
  return { configured: true, modelId, weightsBytes: bytes, runtimeValidated: false, productionEnabled: false,
    ...(privateTest ? { privateTestOnly: true, formalReviewsCompleted: false } : {}) };
}

export async function main(args) {
  try { console.log(JSON.stringify(await configureLocalModel(args))); return 0; }
  catch (error) {
    const allowed = ["LOCAL_MODEL_REVIEW_REQUIRED", "INVALID_LOCAL_MODEL_ARGUMENTS",
      "WEIGHTS_OUTSIDE_DATA_ROOT", "MODEL_WEIGHTS_TOO_LARGE", "INPUT_CHANGED", "LOCAL_MODEL_SOURCE_INVALID"];
    const code = error.code === "EEXIST" ? "LOCAL_MODEL_CONFIG_EXISTS"
      : allowed.includes(error.message) ? error.message : "LOCAL_MODEL_INPUT_UNAVAILABLE";
    console.log(JSON.stringify({ error: { code }, productionEnabled: false }));
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}

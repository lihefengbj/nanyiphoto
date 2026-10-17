import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, realpath, link, unlink, mkdtemp } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const COMMIT = "28165a451e4610c9d77cfdf925a94610bb2810fb";
export const FILE_ID = "1cgycTQlYXpTh26gB9FTnthE7AvruV8hd";
export const SOURCE = `https://drive.google.com/file/d/${FILE_ID}/view`;
const CODE_ROOT = `https://raw.githubusercontent.com/ZHKKKe/MODNet/${COMMIT}/`;
export const DOWNLOAD_URLS = [
  `https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&confirm=t`,
  `https://drive.google.com/uc?export=download&id=${FILE_ID}`
];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const inside = (root, path) => {
  const name = relative(root, path);
  return !!name && name !== ".." && !name.replaceAll("\\", "/").startsWith("../") && !isAbsolute(name);
};

export function allowedDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (["drive.google.com", "drive.usercontent.google.com", "docs.google.com"].includes(url.hostname)
        || url.hostname.endsWith(".googleusercontent.com"));
  } catch { return false; }
}

async function privateWrite(path, data) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(data); }
  finally { await handle.close(); }
}

async function boundedBody(response, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("MODEL_DOWNLOAD_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function officialText(path, fetcher, timeout) {
  const response = await fetcher(CODE_ROOT + path, {
    redirect: "error", signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error("MODEL_SOURCE_UNAVAILABLE");
  return boundedBody(response, 65536);
}

export async function streamWeights(response, path, { maxBytes = 512 * 1024 * 1024 } = {}) {
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || /text\/|json|html/.test(type)) throw new Error("MODEL_DOWNLOAD_NOT_BINARY");
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error("MODEL_DOWNLOAD_TOO_LARGE");
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("MODEL_DOWNLOAD_TOO_LARGE");
      hash.update(chunk);
      // writeFile handles partial OS writes; each call stays bounded by a chunk.
      await handle.writeFile(chunk);
    }
    if (!bytes || (length && bytes !== Number(length))) throw new Error("MODEL_DOWNLOAD_INCOMPLETE");
    return { bytes, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

async function googleResponse(value, fetcher, timeout) {
  let url = value;
  const signal = AbortSignal.timeout(timeout);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!allowedDownloadUrl(url)) throw new Error("UNTRUSTED_MODEL_REDIRECT");
    const response = await fetcher(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const destination = response.headers.get("location");
    await response.body?.cancel();
    if (!destination) throw new Error("MODEL_DOWNLOAD_UNAVAILABLE");
    url = new URL(destination, url).href;
  }
  throw new Error("MODEL_DOWNLOAD_UNAVAILABLE");
}

export async function downloadModnet({
  workspace = ROOT, fetcher = fetch, timeout = 15000
} = {}) {
  const root = await realpath(workspace);
  await mkdir(resolve(root, ".data"), { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(resolve(root, ".data"));
  if (!inside(root, dataRoot)) throw new Error("MODEL_DATA_ROOT_INVALID");
  for (const name of ["models", "model-materials"]) {
    await mkdir(resolve(dataRoot, name), { recursive: true, mode: 0o700 });
    if (!inside(dataRoot, await realpath(resolve(dataRoot, name)))) throw new Error("MODEL_DATA_ROOT_INVALID");
  }
  const models = await realpath(resolve(dataRoot, "models"));
  const materials = await mkdtemp(resolve(dataRoot, "model-materials/modnet-"));
  const record = {
    schemaVersion: 1, modelId: "modnet", codeCommit: COMMIT, source: SOURCE,
    checkedAt: new Date().toISOString(), checkMethod: "automated_official_source_verification",
    requestedOperationScope: "private_authorized_photo_device_tests_only",
    downloaded: false, runtimeValidated: false, productionEnabled: false
  };
  let partial;
  try {
    const readme = await officialText("README.md", fetcher, timeout);
    const onnxReadme = await officialText("onnx/README.md", fetcher, timeout);
    const license = await officialText("LICENSE", fetcher, timeout);
    if (!onnxReadme.toString("utf8").includes(`/file/d/${FILE_ID}/view`)
        || !readme.toString("utf8").includes("The code, models, and demos")
        || !license.toString("utf8").includes("Apache License")
        || !license.toString("utf8").includes("Version 2.0")) throw new Error("MODEL_SOURCE_CHANGED");
    await privateWrite(resolve(materials, "README.md"), readme);
    await privateWrite(resolve(materials, "ONNX-README.md"), onnxReadme);
    await privateWrite(resolve(materials, "LICENSE.txt"), license);
    Object.assign(record, {
      sourceVerified: true, licenseIdentifier: "Apache-2.0",
      readmeSha256: sha256(readme), onnxReadmeSha256: sha256(onnxReadme), licenseSha256: sha256(license)
    });
    let downloaded;
    for (const url of DOWNLOAD_URLS) {
      partial = resolve(models, `.modnet-${randomUUID()}.partial`);
      try {
        downloaded = await streamWeights(await googleResponse(url, fetcher, timeout), partial);
        break;
      } catch (error) {
        await unlink(partial).catch(() => {});
        partial = null;
        if (["UNTRUSTED_MODEL_REDIRECT", "MODEL_DOWNLOAD_TOO_LARGE"].includes(error.message)) throw error;
      }
    }
    if (!downloaded) throw new Error("MODEL_DOWNLOAD_UNAVAILABLE");
    // Atomic, non-overwriting publication: existing user weights remain intact.
    await link(partial, resolve(models, "modnet.onnx"));
    await unlink(partial);
    partial = null;
    Object.assign(record, { downloaded: true, bytes: downloaded.bytes, locallyComputedSha256: downloaded.sha256 });
    await privateWrite(resolve(materials, "record.json"), JSON.stringify(record, null, 2));
    return {
      downloaded: true, modelId: "modnet", materialRunId: materials.split(/[\\/]/).at(-1),
      bytes: downloaded.bytes, runtimeValidated: false, productionEnabled: false
    };
  } catch (error) {
    if (partial) await unlink(partial).catch(() => {});
    const allowed = [
      "MODEL_SOURCE_CHANGED", "MODEL_SOURCE_UNAVAILABLE", "MODEL_DOWNLOAD_UNAVAILABLE",
      "MODEL_DOWNLOAD_TOO_LARGE", "UNTRUSTED_MODEL_REDIRECT"
    ];
    const code = error.code === "EEXIST" ? "MODEL_WEIGHTS_ALREADY_EXIST"
      : allowed.includes(error.message) ? error.message : "MODEL_DOWNLOAD_UNAVAILABLE";
    record.errorCode = code;
    await privateWrite(resolve(materials, "record.json"), JSON.stringify(record, null, 2));
    const failure = new Error(code);
    failure.materialRunId = materials.split(/[\\/]/).at(-1);
    throw failure;
  }
}

export async function main(args) {
  if (args.length) { console.log(JSON.stringify({ error: { code: "INVALID_ARGUMENTS" } })); return 2; }
  try { console.log(JSON.stringify(await downloadModnet())); return 0; }
  catch (error) {
    const allowed = [
      "MODEL_SOURCE_CHANGED", "MODEL_SOURCE_UNAVAILABLE", "MODEL_DOWNLOAD_UNAVAILABLE",
      "MODEL_DOWNLOAD_TOO_LARGE", "UNTRUSTED_MODEL_REDIRECT", "MODEL_WEIGHTS_ALREADY_EXIST",
      "MODEL_DATA_ROOT_INVALID"
    ];
    console.log(JSON.stringify({
      downloaded: false, error: { code: allowed.includes(error.message) ? error.message : "MODEL_DOWNLOAD_UNAVAILABLE" },
      ...(error.materialRunId ? { materialRunId: error.materialRunId } : {}),
      productionEnabled: false
    }));
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}

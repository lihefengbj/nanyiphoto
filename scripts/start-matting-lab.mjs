import { randomBytes } from "node:crypto";
import { open, mkdir, realpath, readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const inside = (root, path) => {
  const name = relative(root, path);
  return !!name && name !== ".." && !name.startsWith("../") && !isAbsolute(name);
};
const quoted = (value) => JSON.stringify(value);

export function parseArguments(args) {
  let prepare = false, lan = false, port = 8000;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error("INVALID_LAB_ARGUMENTS");
    seen.add(arg);
    if (arg === "--prepare") prepare = true;
    else if (arg === "--lan") lan = true;
    else if (arg === "--port" && /^\d{1,5}$/.test(args[index + 1] || "")) {
      port = Number(args[++index]);
      if (port < 1 || port > 65535) throw new Error("INVALID_LAB_ARGUMENTS");
    } else throw new Error("INVALID_LAB_ARGUMENTS");
  }
  return { prepare, lan, port };
}

export function privateUrls(port, interfaces = networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter((value) => {
    if (!value || value.internal || value.family !== "IPv4") return false;
    const ip = value.address.split(".").map(Number);
    return ip[0] === 10 || (ip[0] === 192 && ip[1] === 168)
      || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31);
  }).map((value) => `http://${value.address}:${port}`))];
}

export async function prepareDeviceLab(workspace = ROOT) {
  const root = await realpath(workspace);
  const data = await realpath(resolve(root, ".data"));
  if (!inside(root, data)) throw new Error("INVALID_LAB_DATA_ROOT");
  const model = await realpath(resolve(data, "local-model.json"));
  if (!inside(data, model) || !(await stat(model)).isFile()) throw new Error("LOCAL_MODEL_NOT_CONFIGURED");
  await mkdir(resolve(data, "device-lab"), { recursive: true, mode: 0o700 });
  if (!inside(data, await realpath(resolve(data, "device-lab")))) throw new Error("INVALID_LAB_DATA_ROOT");
  const file = resolve(data, "device-lab.env");
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await realpath(file);
    const info = await stat(existing);
    if (!inside(data, existing) || !info.isFile() || info.size > 8192 || (info.mode & 0o077)) {
      throw new Error("INVALID_LAB_ENVIRONMENT");
    }
    const content = await readFile(existing, "utf8");
    if (!/^NP_DEV_TOKEN=[a-f0-9]{64}$/m.test(content)
        || !/^NP_ENV=local$/m.test(content) || !/^NP_MATTING_LAB=true$/m.test(content)) {
      throw new Error("INVALID_LAB_ENVIRONMENT");
    }
    return { root, file: existing, reused: true };
  }
  try {
    await handle.writeFile([
      "# Private local device tests only. Do not publish or commit this file.",
      "NP_ENV=local", "NP_MATTING_LAB=true",
      `NP_LOCAL_MODEL_PATH=${quoted(model)}`, "NP_LOCAL_MODEL_ENGINE=onnx-reference",
      `NP_DEV_TOKEN=${randomBytes(32).toString("hex")}`, "NP_DEV_OWNER=private-device-tester",
      `NP_DATABASE_URL=${quoted("sqlite:///" + resolve(data, "device-lab/tasks.sqlite3"))}`,
      `NP_STORAGE_ROOT=${quoted(resolve(data, "device-lab/objects"))}`,
      `NP_CATALOG_PATH=${quoted(resolve(root, "config/specs.example.json"))}`,
      "NP_MAX_UPLOAD_BYTES=4194304", "NP_MAX_IMAGE_PIXELS=4194304",
      "NP_LOG_CONSOLE=true", `NP_LOG_FILE=${quoted(resolve(data, "device-lab/api.jsonl"))}`,
      "NP_LOG_MAX_BYTES=1048576", "NP_LOG_BACKUP_COUNT=3", ""
    ].join("\n"));
  } finally { await handle.close(); }
  return { root, file, reused: false };
}

export async function main(args) {
  const options = parseArguments(args);
  const prepared = await prepareDeviceLab();
  console.log(JSON.stringify({
    prepared: true, reused: prepared.reused, credentialsFile: ".data/device-lab.env",
    developmentOnly: true, productionEnabled: false,
    ...(options.prepare ? {} : {
      host: options.lan ? "0.0.0.0" : "127.0.0.1", port: options.port,
      candidatePrivateUrls: options.lan ? privateUrls(options.port) : [`http://127.0.0.1:${options.port}`]
    })
  }));
  if (options.prepare) return 0;
  const python = resolve(prepared.root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NP_")));
  const child = spawn(python, ["-m", "uvicorn", "nanyiphoto_api.main:app",
    "--env-file", prepared.file, "--host", options.lan ? "0.0.0.0" : "127.0.0.1",
    "--port", String(options.port), "--no-access-log", "--log-level", "warning"], {
    cwd: prepared.root, env, stdio: "inherit"
  });
  const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", () => reject(new Error("LAB_START_FAILED")));
      child.once("exit", (code) => resolveExit(code ?? 0));
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    const allowed = ["INVALID_LAB_ARGUMENTS", "INVALID_LAB_DATA_ROOT", "INVALID_LAB_ENVIRONMENT",
      "LOCAL_MODEL_NOT_CONFIGURED", "LAB_START_FAILED"];
    console.log(JSON.stringify({ error: { code: allowed.includes(error.message) ? error.message : "LAB_SETUP_FAILED" } }));
    process.exitCode = 1;
  }
}

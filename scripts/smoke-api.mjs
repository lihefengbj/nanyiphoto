import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, rmdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const localPython = resolve(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const python = process.env.NP_PYTHON || (existsSync(localPython) ? localPython : "python");
mkdirSync(resolve(root, ".data"), { recursive: true });
const identifier = randomUUID();
const database = resolve(root, `.data/smoke-${identifier}.sqlite3`);
const objects = resolve(root, `.data/smoke-${identifier}-objects`);
const token = randomBytes(32).toString("hex");
const socket = createServer();
await new Promise((resolvePort, reject) => {
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", resolvePort);
});
const port = socket.address().port;
await new Promise((close) => socket.close(close));
const child = spawn(python, [
  "-m", "uvicorn", "nanyiphoto_api.main:app", "--host", "127.0.0.1", "--port", String(port),
  "--log-level", "error", "--no-access-log"
], {
  cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, NP_ENV: "local", NP_DEV_TOKEN: token, NP_DEV_OWNER: "smoke-user",
    NP_DATABASE_URL: "sqlite:///" + database.replaceAll("\\", "/"),
    NP_STORAGE_ROOT: objects, NP_CATALOG_PATH: resolve(root, "config/specs.example.json"),
    NP_MAX_UPLOAD_BYTES: "4194304", NP_MAX_IMAGE_PIXELS: "4194304", NP_QUEUE_CAPACITY: "8",
    NP_TASK_TTL_SECONDS: "600", NP_UPLOAD_TTL_SECONDS: "300", NP_RESULT_TTL_SECONDS: "600",
    NP_LOG_LEVEL: "INFO", NP_LOG_CONSOLE: "true", NP_LOG_FILE: ""
  }
});
let logs = "";
let spawnError;
child.on("error", (error) => { spawnError = error; });
child.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-10000); });
const base = `http://127.0.0.1:${port}`;
try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`API exited before startup: ${logs}`);
    try {
      const response = await fetch(`${base}/health/live`, { signal: AbortSignal.timeout(300) });
      if (response.status === 200) { started = true; break; }
    } catch {}
    await new Promise((delay) => setTimeout(delay, 100));
  }
  if (!started) throw new Error("API did not start within the bounded startup window.");
  const scenarios = [
    ["/health/ready", {}, 503],
    ["/api/specs", {}, 401],
    ["/api/specs", { headers: { "X-WX-OPENID": "smoke-user" } }, 401],
    ["/api/specs", { headers: { Authorization: `Bearer ${token}` } }, 200],
    ["/api/callbacks/moderation", { method: "POST" }, 503]
  ];
  for (const [path, options, expected] of scenarios) {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(2000) });
    if (response.status !== expected) throw new Error(`${path}: expected ${expected}, got ${response.status}`);
    const requestId = response.headers.get("x-request-id");
    if (!/^[a-f0-9]{32}$/.test(requestId || "")) throw new Error(`${path}: missing safe request ID`);
    if (path === "/api/specs" && expected === 200 && (await response.json()).specs.length !== 0) {
      throw new Error("Draft specifications were incorrectly exposed as available.");
    }
  }
  await new Promise((delay) => setTimeout(delay, 100));
  if (logs.includes(token) || logs.includes("smoke-user")) {
    throw new Error("Sensitive development identity leaked into service logs.");
  }
  if (!logs.split("\n").some((line) => {
    try { const record = JSON.parse(line); return record.event === "http.request" && record.requestId; }
    catch { return false; }
  })) throw new Error("Structured request diagnostics were not captured.");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    // Windows virtualenv launchers may have an interpreter child. Kill only
    // the process tree rooted at this script's own spawned PID.
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore"
      });
    } else child.kill();
    await Promise.race([
      new Promise((exit) => child.once("exit", exit)),
      new Promise((delay) => setTimeout(delay, 3000))
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // Only exact, randomly named files/directories created for this smoke run;
  // no recursive deletion, globbing or user database cleanup.
  for (const path of [database, database + "-wal", database + "-shm"]) {
    for (let attempt = 0; existsSync(path); attempt++) {
      try { unlinkSync(path); }
      catch (error) {
        if (!["EBUSY", "EPERM"].includes(error.code) || attempt >= 20) throw error;
        await new Promise((delay) => setTimeout(delay, 100));
      }
    }
  }
  if (existsSync(objects)) rmdirSync(objects);
}
console.log("Live API smoke passed: authentication, gates, request IDs and safe structured diagnostics; process cleaned up.");

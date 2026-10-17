const { safeCode } = require("../utils/logger");

function privateBaseUrl(value) {
  if (typeof value !== "string") throw new Error("INVALID_LAB_CONFIG");
  const match = /^(https?):\/\/(localhost|(?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?\/?$/.exec(value.trim());
  if (!match) throw new Error("INVALID_LAB_CONFIG");
  let host = match[2];
  if (host !== "localhost") {
    const ip = host.split(".").map(Number);
    if (ip.some((part) => part > 255)
        || !(ip[0] === 127 || ip[0] === 10 || (ip[0] === 192 && ip[1] === 168)
          || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31))) throw new Error("INVALID_LAB_CONFIG");
    host = ip.join(".");
  }
  if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) throw new Error("INVALID_LAB_CONFIG");
  return `${match[1]}://${host}${match[3] ? ":" + match[3] : ""}`;
}

function jobPath(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new Error("INVALID_LAB_RESULT");
  return `/api/lab/jobs/${id}`;
}

function createMattingLabClient(config, platform = wx) {
  const base = privateBaseUrl(config.baseUrl);
  const token = config.token;
  if (typeof token !== "string" || token.length < 16 || token.length > 128 || /[\r\n]/.test(token)) {
    throw new Error("LOCAL_TOKEN_NOT_CONFIGURED");
  }
  const operations = new Set();
  function run(kind, path, options = {}) {
    return new Promise((resolve, reject) => {
      const operation = { task: null, settled: false };
      const finish = (error, value) => {
        if (operation.settled) return;
        operation.settled = true;
        operations.delete(operation);
        if (error) reject(new Error(safeCode(error, "API_FAILED")));
        else resolve(value);
      };
      operation.cancel = () => {
        finish("USER_CANCELLED");
        if (operation.task && operation.task.abort) operation.task.abort();
      };
      operations.add(operation);
      const args = {
        url: base + path, header: { Authorization: `Bearer ${token}`, ...options.header },
        timeout: 30000, ...options,
        success(response) {
          if (!response || !Number.isInteger(response.statusCode)) return finish("API_FAILED");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return finish(response.data && response.data.error && response.data.error.code || "API_FAILED");
          }
          finish(null, kind === "downloadFile" ? response : response.data);
        },
        fail() { finish("NETWORK_FAILED"); }
      };
      // Never let caller-supplied headers replace development identity.
      args.header = { ...options.header, Authorization: `Bearer ${token}` };
      try { operation.task = platform[kind](args); }
      catch { finish("NETWORK_FAILED"); }
    });
  }
  return {
    status: () => run("request", "/api/lab/status", { method: "GET" }),
    create: (data, key) => run("request", "/api/lab/jobs", {
      method: "POST", data, header: {
        "Content-Type": "application/octet-stream", "X-Lab-Consent": "authorized-test-photo",
        "Idempotency-Key": key
      }
    }),
    get: (id) => run("request", jobPath(id), { method: "GET" }),
    cancel: (id) => run("request", jobPath(id), { method: "DELETE" }),
    download: (id, filePath) => run("downloadFile", jobPath(id) + "/cutout", { filePath }),
    abortAll: () => Array.from(operations).forEach((operation) => operation.cancel())
  };
}

function validateLabResult(result, ready = false) {
  if (!result || !/^[a-f0-9]{32}$/.test(result.jobId)
      || result.developmentOnly !== true || result.moderation !== "not_performed"
      || !["queued", "processing", "ready", "failed", "cancelled", "expired"].includes(result.state)
      || !Number.isInteger(result.width) || !Number.isInteger(result.height)
      || result.width < 1 || result.height < 1 || result.width * result.height > 1024 * 1024
      || (ready && result.state !== "ready")) throw new Error("INVALID_LAB_RESULT");
  return result;
}

async function waitForMatting(client, id, { active, wait, onState = () => {}, now = Date.now, timeout = 240000 }) {
  const deadline = now() + timeout;
  for (let attempt = 0; attempt < 240 && now() <= deadline; attempt++) {
    if (!active()) throw new Error("USER_CANCELLED");
    const result = validateLabResult(await client.get(id));
    if (!active()) throw new Error("USER_CANCELLED");
    if (now() > deadline) throw new Error("TIMEOUT");
    onState(result.state);
    if (result.state === "ready") return result;
    if (["cancelled", "expired"].includes(result.state)) throw new Error("USER_CANCELLED");
    if (result.state === "failed") throw new Error(safeCode(result.errorCode, "MODEL_FAILED"));
    await wait(1000);
  }
  throw new Error("TIMEOUT");
}

module.exports = { privateBaseUrl, createMattingLabClient, validateLabResult, waitForMatting };

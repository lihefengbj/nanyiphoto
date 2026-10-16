const { logger, safeCode, routeTemplate } = require("../utils/logger");

function createApi(config) {
  if (!config || !["local", "cloud"].includes(config.transport)) throw new Error("INVALID_API_CONFIG");
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    const method = options.method || "GET";
    const diagnostics = config.logger || logger;
    const record = (event, level, fields) => {
      try {
        diagnostics.emit(event, level, {
          route: routeTemplate(path), method, durationMs: Math.max(0, Date.now() - started), ...fields
        });
      } catch { /* Logging must not interfere with transport. */ }
    };
    const failed = (code, fields = {}) => {
      if (settled) return;
      settled = true;
      const error = new Error(safeCode(code));
      if (fields.requestId) error.requestId = fields.requestId;
      if (Number.isInteger(fields.status)) error.statusCode = fields.status;
      record("network.failed", fields.status >= 500 ? "ERROR" : "WARNING", { ...fields, errorCode: error.message });
      reject(error);
    };
    const header = { ...(options.header || {}) };
    if (config.transport === "local") {
      if (!config.developmentToken) return failed("LOCAL_TOKEN_NOT_CONFIGURED");
      header.Authorization = `Bearer ${config.developmentToken}`;
    }
    const success = (response) => {
      if (settled) return;
      if (!response || !Number.isInteger(response.statusCode)) return failed("API_FAILED");
      const responseHeaders = response.header || {};
      const key = Object.keys(responseHeaders).find((name) => name.toLowerCase() === "x-request-id");
      const value = key && responseHeaders[key];
      const requestId = typeof value === "string" && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
      const fields = { status: response.statusCode, requestId };
      if ((response.statusCode >= 200 && response.statusCode < 300) || response.statusCode === 304) {
        settled = true;
        record("network.completed", "INFO", fields);
        resolve(response.statusCode === 304 ? { notModified: true } : response.data);
      } else {
        const code = safeCode(response.data && response.data.error && response.data.error.code);
        failed(code, fields);
      }
    };
    const args = {
      path, method, data: options.data, header,
      timeout: 10000, success, fail: () => failed("NETWORK_FAILED")
    };
    try {
      if (config.transport === "cloud") {
        if (!config.cloudEnvironment || !config.cloudService) return failed("CLOUD_NOT_CONFIGURED");
        wx.cloud.callContainer({ ...args, config: { env: config.cloudEnvironment }, header: {
          ...header, "X-WX-SERVICE": config.cloudService
        } });
      } else wx.request({ ...args, url: config.baseUrl + path });
    } catch { failed("NETWORK_FAILED"); }
  });
  return {
    request,
    getSpecs: (etag) => request("/api/specs", { header: etag ? { "If-None-Match": etag } : {} }),
    createUpload: () => request("/api/uploads", { method: "POST" }),
    getTask: (id) => request(`/api/tasks/${encodeURIComponent(id)}`),
    cancelTask: (id) => request(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
  };
}
module.exports = { createApi };

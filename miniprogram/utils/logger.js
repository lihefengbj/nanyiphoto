const levels = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
const events = new Set([
  "diagnostic.invalid", "app.started", "network.completed", "network.failed", "network.rejected",
  "privacy.agreed", "privacy.declined", "privacy.unavailable", "privacy.contract_failed",
  "lab.canvas_unavailable", "lab.photo_selected", "lab.photo_failed",
  "lab.export_completed", "lab.export_failed", "lab.local_key_completed", "lab.local_key_failed",
  "lab.save_completed", "lab.save_failed", "lab.cleanup_failed"
]);
const codes = new Set([
  "INVALID_LAB_CONFIG", "INVALID_LAB_RESULT", "MATTING_LAB_DISABLED", "LOCAL_MODEL_NOT_CONFIGURED",
  "LOCAL_MODEL_REVIEW_REQUIRED", "MODEL_RUNTIME_UNAVAILABLE", "LAB_CONSENT_REQUIRED", "INVALID_LAB_REQUEST",
  "WEIGHTS_HASH_MISMATCH", "MODEL_LOAD_FAILED", "TIMEOUT",
  "API_FAILED", "NETWORK_FAILED", "LOCAL_TOKEN_NOT_CONFIGURED", "CLOUD_NOT_CONFIGURED",
  "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED", "UPLOAD_TOO_LARGE", "UPLOAD_EXPIRED",
  "UPLOAD_IMMUTABLE", "UPLOAD_NOT_READY", "IDEMPOTENCY_CONFLICT", "SPEC_VERSION_CHANGED",
  "SPEC_UNAVAILABLE", "PROVIDERS_NOT_CONFIGURED", "QUEUE_FULL", "RESULT_NOT_AVAILABLE",
  "MODERATION_CALLBACK_NOT_CONFIGURED", "MODERATION_DECISION_CONFLICT", "MODEL_FAILED",
  "INTERNAL_ERROR", "INPUT_CHANGED", "INVALID_MODEL_RESULT", "INVALID_FOREGROUND_ALPHA",
  "UNSUPPORTED_IMAGE_FORMAT", "IMAGE_PIXELS_EXCEEDED", "NORMALIZED_IMAGE_TOO_LARGE",
  "INVALID_IMAGE", "MODEL_RESULT_TOO_LARGE", "WORKER_LEASE_EXHAUSTED",
  "PRIVACY_API_UNAVAILABLE", "PRIVACY_UNAVAILABLE", "PERMISSION_DENIED", "USER_CANCELLED",
  "PHOTO_TOO_LARGE", "FORMAT_UNSUPPORTED", "ORIENTATION_UNVERIFIED", "PHOTO_FAILED",
  "CANVAS_UNAVAILABLE", "EXPORT_FAILED", "SAVE_FAILED", "TEMP_CLEANUP_FAILED",
  "BACKGROUND_NOT_FOUND", "BACKGROUND_REMOVED_TOO_MUCH", "LOCAL_KEY_FAILED",
  "INVALID_CHROMA_INPUT", "INVALID_CHROMA_COLOR",
  "INVALID_TRANSFORM", "INVALID_EXPORT", "EXPORT_DIMENSION_MISMATCH",
  "EXPORT_FORMAT_MISMATCH", "EXPORT_SIZE_INVALID", "EXPORT_SIZE_OUT_OF_BOUNDS"
]);
const routes = new Set([
  "/health/live", "/health/ready", "/api/specs", "/api/uploads", "/api/matting",
  "/api/uploads/{upload_id}/file", "/api/tasks/{task_id}", "/api/tasks/{task_id}/assets/{name}",
  "/api/callbacks/moderation", "<unmatched>"
]);

function safeCode(value, fallback = "API_FAILED") {
  return codes.has(value) ? value : codes.has(fallback) ? fallback : "API_FAILED";
}

function platformCode(error, fallback) {
  if (error && codes.has(error.message)) return error.message;
  const message = error && typeof error.errMsg === "string" ? error.errMsg : "";
  if (/\bcancel\b/i.test(message)) return "USER_CANCELLED";
  if (/auth.*deny|permission.*denied|authorize.*fail/i.test(message)) return "PERMISSION_DENIED";
  return safeCode(fallback);
}

function routeTemplate(path) {
  if (routes.has(path)) return path;
  if (typeof path !== "string") return "<unmatched>";
  if (/^\/api\/uploads\/[^/?]+\/file$/.test(path)) return "/api/uploads/{upload_id}/file";
  if (/^\/api\/tasks\/[^/?]+\/assets\/[^/?]+$/.test(path)) return "/api/tasks/{task_id}/assets/{name}";
  if (/^\/api\/tasks\/[^/?]+$/.test(path)) return "/api/tasks/{task_id}";
  return "<unmatched>";
}

function createLogger(options = {}) {
  let enabled = false;
  let level = "INFO";
  let maxEntries = 100;
  const entries = [];
  const sink = options.sink || ((record) => console.log(JSON.stringify(record)));
  function configure(config = {}) {
    enabled = config.enabled === true;
    level = Object.prototype.hasOwnProperty.call(levels, config.level) ? config.level : "INFO";
    maxEntries = Number.isInteger(config.maxEntries) && config.maxEntries >= 1 && config.maxEntries <= 200
      ? config.maxEntries : 100;
    if (!enabled) entries.length = 0;
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
  }
  configure(options);
  return {
    configure,
    emit(event, severity = "INFO", fields = {}) {
      if (!enabled) return;
      try {
        severity = Object.prototype.hasOwnProperty.call(levels, severity) ? severity : "ERROR";
        if (levels[severity] < levels[level]) return;
        const record = {
          timestamp: new Date().toISOString(), level: severity,
          event: events.has(event) ? event : "diagnostic.invalid"
        };
        // No object traversal, free-form messages, URLs, request data or identity fields.
        for (const key of ["status", "durationMs", "width", "height", "bytes", "attempts", "tolerance"]) {
          const value = fields[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12) {
            record[key] = Math.round(value * 1000) / 1000;
          }
        }
        if (typeof fields.quality === "number" && Number.isFinite(fields.quality)
            && fields.quality > 0 && fields.quality <= 1) {
          record.quality = Math.round(fields.quality * 1000) / 1000;
        }
        if (typeof fields.requestId === "string" && /^[a-f0-9]{32}$/.test(fields.requestId)) {
          record.requestId = fields.requestId;
        }
        if (routes.has(fields.route)) record.route = fields.route;
        if (codes.has(fields.errorCode)) record.errorCode = fields.errorCode;
        if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"].includes(fields.method)) {
          record.method = fields.method;
        }
        if (["privacy", "select", "decode", "export", "save", "cleanup"].includes(fields.stage)) {
          record.stage = fields.stage;
        }
        if (["jpeg", "png"].includes(fields.format)) record.format = fields.format;
        Object.freeze(record);
        entries.push(record);
        if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
        try { sink(record); } catch { /* A console/sink failure must not break the user action. */ }
      } catch { /* Malformed diagnostic input is never a business failure. */ }
    },
    snapshot: () => entries.slice(),
    clear: () => { entries.length = 0; }
  };
}

const logger = createLogger();
module.exports = { logger, createLogger, safeCode, platformCode, routeTemplate };

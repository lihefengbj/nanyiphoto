import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const require = createRequire(import.meta.url);
const { createLogger, logger, platformCode, routeTemplate } = require("../miniprogram/utils/logger.js");
const { createApi } = require("../miniprogram/services/api.js");

test("diagnostics are off by default including bundled configuration", () => {
  let writes = 0;
  const diagnostics = createLogger({ sink: () => { writes++; } });
  diagnostics.emit("app.started");
  assert.deepEqual(diagnostics.snapshot(), []);
  assert.equal(writes, 0);
  assert.equal(require("../miniprogram/config.js").diagnostics.enabled, false);
});

test("logger accepts only bounded scalar evidence and rejects sensitive fields", () => {
  const output = [];
  const diagnostics = createLogger({ enabled: true, sink: (record) => output.push(record) });
  const sensitive = "RAW-photo-token-owner-signed-url";
  diagnostics.emit(sensitive, "ERROR", {
    Authorization: sensitive, owner: sensitive, photo: sensitive, path: sensitive,
    error: { message: sensitive }, route: `/${sensitive}`, errorCode: sensitive,
    requestId: sensitive, width: Infinity, bytes: -1, height: 413, format: "jpeg"
  });
  assert.equal(output[0].event, "diagnostic.invalid");
  assert.equal(output[0].height, 413);
  assert.equal(output[0].format, "jpeg");
  assert.ok(!JSON.stringify(output).includes(sensitive));
  assert.equal(output[0].width, undefined);
  assert.equal(output[0].bytes, undefined);
});

test("memory ring, severity filter and disable switch have explicit bounds", () => {
  const diagnostics = createLogger({ enabled: true, level: "WARNING", maxEntries: 3, sink() {} });
  diagnostics.emit("app.started", "INFO");
  for (let status = 400; status < 410; status++) diagnostics.emit("network.failed", "WARNING", { status });
  assert.deepEqual(diagnostics.snapshot().map((record) => record.status), [407, 408, 409]);
  const snapshot = diagnostics.snapshot();
  snapshot.length = 0;
  assert.equal(diagnostics.snapshot().length, 3);
  assert.throws(() => { diagnostics.snapshot()[0].status = 1; }, TypeError);
  diagnostics.configure({ enabled: false });
  assert.deepEqual(diagnostics.snapshot(), []);
});

test("invalid capacity cannot create an unlimited ring and sink errors are harmless", () => {
  const diagnostics = createLogger({
    enabled: true, maxEntries: Infinity, sink() { throw new Error("RAW-sink-error"); }
  });
  for (let i = 0; i < 250; i++) diagnostics.emit("app.started");
  assert.equal(diagnostics.snapshot().length, 100);
  diagnostics.clear();
  assert.equal(diagnostics.snapshot().length, 0);
});

test("route templates and platform error mapping never retain free text", () => {
  assert.equal(routeTemplate("/api/tasks/private-id"), "/api/tasks/{task_id}");
  assert.equal(routeTemplate("/api/tasks/private-id/assets/alpha"), "/api/tasks/{task_id}/assets/{name}");
  assert.equal(routeTemplate("/unknown?token=private"), "<unmatched>");
  assert.equal(platformCode({ errMsg: "saveImageToPhotosAlbum:fail auth deny private-path" }, "SAVE_FAILED"),
    "PERMISSION_DENIED");
  assert.equal(platformCode({ errMsg: "chooseMedia:fail cancel private-path" }, "PHOTO_FAILED"), "USER_CANCELLED");
  assert.equal(platformCode({ message: "RAW-private" }, "PHOTO_FAILED"), "PHOTO_FAILED");
});

test("API errors expose safe request ID and status without logging headers or payloads", async () => {
  const output = [];
  const diagnostics = createLogger({ enabled: true, sink: (record) => output.push(record) });
  const identifier = "a".repeat(32);
  const sensitive = "RAW-development-token-photo-task-id";
  globalThis.wx = { request(args) {
    assert.equal(args.header.Authorization, `Bearer ${sensitive}`);
    args.success({
      statusCode: 503, header: { "X-Request-ID": identifier },
      data: { error: { code: "PROVIDERS_NOT_CONFIGURED", message: sensitive }, photo: sensitive }
    });
  } };
  try {
    const api = createApi({ transport: "local", baseUrl: "http://127.0.0.1", developmentToken: sensitive,
      logger: diagnostics });
    await assert.rejects(api.request(`/api/tasks/${sensitive}`, { data: { photo: sensitive } }), (error) => {
      assert.equal(error.message, "PROVIDERS_NOT_CONFIGURED");
      assert.equal(error.requestId, identifier);
      assert.equal(error.statusCode, 503);
      return true;
    });
    assert.equal(output.length, 1);
    assert.equal(output[0].requestId, identifier);
    assert.equal(output[0].route, "/api/tasks/{task_id}");
    assert.ok(!JSON.stringify(output).includes(sensitive));
  } finally { delete globalThis.wx; }
});

test("untrusted remote error text and malformed identifiers become generic safe errors", async () => {
  const output = [];
  const diagnostics = createLogger({ enabled: true, sink: (record) => output.push(record) });
  const sensitive = "RAW-signature-token";
  globalThis.wx = { request(args) {
    args.success({ statusCode: 500, header: { "x-request-id": sensitive }, data: { error: { code: sensitive } } });
  } };
  try {
    const api = createApi({ transport: "local", developmentToken: "fixture", logger: diagnostics });
    await assert.rejects(api.getSpecs(), (error) => error.message === "API_FAILED" && !error.requestId);
    assert.ok(!JSON.stringify(output).includes(sensitive));
  } finally { delete globalThis.wx; }
});

test("network failures and missing identity are logged without paid automatic retries", async () => {
  const output = [];
  const diagnostics = createLogger({ enabled: true, sink: (record) => output.push(record) });
  let calls = 0;
  globalThis.wx = { request(args) { calls++; args.fail({ errMsg: "RAW-url-and-token" }); } };
  try {
    await assert.rejects(createApi({ transport: "local", logger: diagnostics }).getSpecs(), /TOKEN_NOT_CONFIGURED/);
    await assert.rejects(createApi({ transport: "local", developmentToken: "fixture",
      logger: diagnostics }).getSpecs(), /NETWORK_FAILED/);
    assert.equal(calls, 1);
    assert.equal(output.length, 2);
    assert.ok(!JSON.stringify(output).includes("RAW-url-and-token"));
  } finally { delete globalThis.wx; }
});

test("successful responses and 304 stay compatible while capturing correlation", async () => {
  const diagnostics = createLogger({ enabled: true, sink() {} });
  let status = 200;
  globalThis.wx = { request(args) {
    args.success({ statusCode: status, header: { "x-request-id": "b".repeat(32) }, data: { specs: [] } });
  } };
  try {
    const api = createApi({ transport: "local", developmentToken: "fixture", logger: diagnostics });
    assert.deepEqual(await api.getSpecs(), { specs: [] });
    status = 304;
    assert.deepEqual(await api.getSpecs(), { notModified: true });
    assert.equal(diagnostics.snapshot().length, 2);
    assert.ok(diagnostics.snapshot().every((record) => record.event === "network.completed"));
  } finally { delete globalThis.wx; }
});

test("synchronous transport failures are safe and duplicate callbacks do not duplicate logs", async () => {
  const diagnostics = createLogger({ enabled: true, sink() {} });
  globalThis.wx = { request() { throw new Error("RAW-platform-config-and-token"); } };
  try {
    const api = createApi({ transport: "local", developmentToken: "fixture", logger: diagnostics });
    await assert.rejects(api.getSpecs(), /NETWORK_FAILED/);
    globalThis.wx.request = (args) => {
      args.success({ statusCode: 200, data: { specs: [] } });
      args.fail({ errMsg: "RAW-platform-message" });
    };
    assert.deepEqual(await api.getSpecs(), { specs: [] });
    assert.equal(diagnostics.snapshot().length, 2);
    assert.ok(!JSON.stringify(diagnostics.snapshot()).includes("RAW-platform"));
  } finally { delete globalThis.wx; }
});

function loadLab(wx) {
  let page;
  const context = createContext({
    wx, Page(value) { page = value; },
    require(path) {
      return path.endsWith("geometry") ? require("../miniprogram/utils/geometry.js")
        : require("../miniprogram/utils/logger.js");
    }
  });
  new Script(readFileSync(new URL("../miniprogram/pages/lab/lab.js", import.meta.url), "utf8")).runInContext(context);
  page.data = { ...page.data };
  page.setData = (value) => { Object.assign(page.data, value); };
  page.alive = true;
  return page;
}

test("lab logs exact export validation code and never logs temporary image paths", async () => {
  logger.configure({ enabled: true });
  const sensitive = "RAW-private-photo-temp-path";
  try {
    const page = loadLab({
      canvasToTempFilePath(args) { args.success({ tempFilePath: sensitive }); },
      getImageInfo(args) { args.success({ width: 1, height: 1, type: "jpeg", path: sensitive }); },
      getFileSystemManager() { return { stat(args) { args.success({ stats: { size: 100 } }); } }; }
    });
    page.canvas = { width: 295, height: 413 };
    page.image = {};
    page.ownedExports = new Set();
    await page.exportPhoto();
    const event = logger.snapshot().at(-1);
    assert.equal(event.event, "lab.export_failed");
    assert.equal(event.errorCode, "EXPORT_DIMENSION_MISMATCH");
    assert.ok(!JSON.stringify(logger.snapshot()).includes(sensitive));
    assert.equal(page.data.evidence, null);
  } finally { logger.configure({ enabled: false }); }
});

test("lab photo/save errors classify permissions and do not retain raw wx errors", async () => {
  logger.configure({ enabled: true });
  try {
    const page = loadLab({
      requirePrivacyAuthorize(args) { args.fail({ errMsg: "authorize:fail auth deny RAW-private" }); },
      saveImageToPhotosAlbum(args) { args.fail({ errMsg: "save:fail auth deny RAW-private" }); }
    });
    page.canvas = {};
    await page.choosePhoto();
    assert.equal(logger.snapshot().at(-1).errorCode, "PERMISSION_DENIED");
    page.outputPath = "RAW-private";
    page.data.evidence = { width: 295 };
    await page.save();
    assert.equal(logger.snapshot().at(-1).event, "lab.save_failed");
    assert.ok(!JSON.stringify(logger.snapshot()).includes("RAW-private"));
  } finally { logger.configure({ enabled: false }); }
});

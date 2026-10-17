import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
const require = createRequire(import.meta.url);
const { privateBaseUrl, createMattingLabClient, waitForMatting, validateLabResult } =
  require("../miniprogram/services/matting-lab.js");
const { ManagedFiles } = require("../miniprogram/utils/managed-files.js");
const id = "a".repeat(32);
const token = "test-development-token-for-lab";
const result = (state = "ready") => ({
  jobId: id, state, width: 32, height: 48, developmentOnly: true, moderation: "not_performed"
});

test("private device endpoint rejects public/credential/query URLs and canonicalizes IPv4", () => {
  for (const url of ["http://ZINFOID_04Q:8000", "https://example.com", "http://user:secret@127.0.0.1",
    "http://127.0.0.1/?secret", "http://192.168.1.999", "file:///private", "http://127.0.0.1:0"]) {
    assert.throws(() => privateBaseUrl(url), /INVALID_LAB_CONFIG/);
  }
  assert.equal(privateBaseUrl("http://127.0.0.1:8000/"), "http://127.0.0.1:8000");
  assert.equal(privateBaseUrl("http://010.0.0.1:8000"), "http://10.0.0.1:8000");
  assert.equal(privateBaseUrl("https://172.16.2.3"), "https://172.16.2.3");
});

test("upload uses authorized binary request and has no retry", async () => {
  const requests = [];
  const platform = { request(args) {
    requests.push(args);
    args.success({ statusCode: 202, data: result("queued") });
    return { abort() {} };
  } };
  const client = createMattingLabClient({ baseUrl: "http://127.0.0.1:8000", token }, platform);
  const data = new ArrayBuffer(10);
  await client.create(data, "one-idempotency-key");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data, data);
  assert.equal(requests[0].header["X-Lab-Consent"], "authorized-test-photo");
  assert.equal(requests[0].header.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].method, "POST");
});

test("native transport failures and provider errors never expose untrusted messages", async () => {
  const client = createMattingLabClient({ baseUrl: "http://127.0.0.1", token }, {
    request(args) { args.success({ statusCode: 500, data: { error: { code: "/private/secret-person.jpg" } } }); }
  });
  await assert.rejects(client.status(), /^Error: API_FAILED$/);
  assert.throws(() => client.get("../private"), /INVALID_LAB_RESULT/);
});

test("abort settles once and ignores late native success", async () => {
  let args;
  let aborted = 0;
  const client = createMattingLabClient({ baseUrl: "http://127.0.0.1", token }, {
    request(value) { args = value; return { abort() { aborted++; } }; }
  });
  const pending = client.status();
  client.abortAll();
  await assert.rejects(pending, /USER_CANCELLED/);
  args.success({ statusCode: 200, data: { ready: true } });
  assert.equal(aborted, 1);
});

test("polling returns only valid unaudited development assets and stops on failure", async () => {
  const sequence = [result("queued"), result("processing"), result("ready")];
  const phases = [];
  const output = await waitForMatting({ get: async () => sequence.shift() }, id, {
    active: () => true, wait: async () => {}, onState: (state) => phases.push(state)
  });
  assert.equal(output.state, "ready");
  assert.deepEqual(phases, ["queued", "processing", "ready"]);
  await assert.rejects(waitForMatting({ get: async () => ({ ...result("failed"), errorCode: "MODEL_FAILED" }) }, id, {
    active: () => true, wait: async () => {}
  }), /MODEL_FAILED/);
});

test("polling has a wall clock deadline and responds to cancellation", async () => {
  let calls = 0;
  const client = { async get() { calls++; return result("queued"); } };
  await assert.rejects(waitForMatting(client, id, {
    active: () => false, wait: async () => {}
  }), /USER_CANCELLED/);
  assert.equal(calls, 0);
  let clock = 0;
  await assert.rejects(waitForMatting(client, id, {
    active: () => true, wait: async () => { clock += 100; }, now: () => clock, timeout: 50
  }), /TIMEOUT/);
  assert.equal(calls, 1);
});

test("unexpected dimensions, production claims and opaque result schemas fail validation", () => {
  for (const changes of [{ width: 0 }, { width: 99999 }, { developmentOnly: false },
    { moderation: "approved" }, { state: "unknown" }, { jobId: "../secret" }]) {
    assert.throws(() => validateLabResult({ ...result(), ...changes }), /INVALID_LAB_RESULT/);
  }
});

function pageFixture({ deferCanvasQuery = false, fakeTimers = false } = {}) {
  let page;
  let sequence = 0;
  const files = new Map();
  const draws = [];
  const requests = [];
  const saved = [];
  const canvasPresent = [true, true];
  const canvasCallbacks = [];
  const canvasSelectors = [];
  const timers = new Map();
  const updates = [];
  let clock = 0;
  let timerSequence = 0;
  const canvases = [0, 1].map((number) => ({
    width: 295, height: 413,
    getContext() {
      return {
        fillRect() { draws.push({ fill: this.fillStyle, canvas: number }); },
        drawImage(image, ...position) { draws.push({ image: image.src, canvas: number, position }); }
      };
    },
    createImage() {
      return {
        set src(path) { this.path = path; this.onload(); },
        get src() { return this.path; }
      };
    }
  }));
  const fs = {
    readdir(args) { args.success({ files: Array.from(files.keys()).map((path) => path.split("/").pop()) }); },
    saveFile(args) { files.set(args.filePath, files.get(args.tempFilePath)); files.delete(args.tempFilePath); args.success({}); },
    stat(args) { args.success({ stats: { size: (files.get(args.path) || {}).bytes || 500 } }); },
    readFile(args) { args.success({ data: new ArrayBuffer(10) }); },
    unlink(args) { files.delete(args.filePath); args.success({}); }
  };
  const platform = {
    env: { USER_DATA_PATH: "/private" }, getFileSystemManager: () => fs,
    requirePrivacyAuthorize(args) { args.success({}); },
    chooseMedia(args) { args.success({ tempFiles: [{ tempFilePath: "/original.jpg", size: 1000 }] }); },
    getImageInfo(args) {
      args.success(args.src === "/original.jpg"
        ? { path: args.src, width: 2400, height: 3600, type: "jpeg", orientation: "up" }
        : { path: args.src, ...files.get(args.src) });
    },
    canvasToTempFilePath(args) {
      const path = `/tmp/generated-${sequence++}`;
      files.set(path, { width: args.destWidth, height: args.destHeight, type: args.fileType === "png" ? "png" : "jpeg", bytes: 500 });
      args.success({ tempFilePath: path });
    },
    request(args) {
      requests.push(args);
      let data;
      if (args.url.endsWith("/status")) data = {
        ready: true, developmentOnly: true, moderation: "not_performed", modelId: "modnet",
        maxInputBytes: 4194304, maxInputPixels: 1048576
      };
      else data = { ...result(), width: canvases[1].width, height: canvases[1].height };
      args.success({ statusCode: 200, data });
      return { abort() {} };
    },
    downloadFile(args) {
      files.set(args.filePath, { width: canvases[1].width, height: canvases[1].height, type: "png", bytes: 1000 });
      args.success({ statusCode: 200, filePath: args.filePath });
      return { abort() {} };
    },
    saveImageToPhotosAlbum(args) { saved.push(args.filePath); args.success({}); },
    showToast() {}
  };
  const filename = new URL("../miniprogram/pages/matting/matting.js", import.meta.url);
  const pageRequire = createRequire(filename);
  const context = createContext({
    wx: platform, Page(value) { page = value; },
    Date: fakeTimers ? class extends Date { static now() { return clock; } } : Date,
    setTimeout: fakeTimers ? (callback) => {
      const id = ++timerSequence;
      timers.set(id, callback);
      return id;
    } : setTimeout,
    clearTimeout: fakeTimers ? (id) => timers.delete(id) : clearTimeout,
    require(path) {
      if (path === "../../services/matting-lab") return {
        ...pageRequire(path),
        createMattingLabClient: (config) => createMattingLabClient(config, platform)
      };
      return pageRequire(path);
    }
  });
  new Script(readFileSync(filename, "utf8")).runInContext(context);
  page.data = { ...page.data, baseUrlText: "http://127.0.0.1:8000", tokenText: token };
  page.setData = (data) => { updates.push({ ...data }); Object.assign(page.data, data); };
  page.createSelectorQuery = () => {
    const queries = [];
    const query = {
      selectAll() {
        return { fields() {
          queries.push(() => canvases.map((node) => ({ node })));
          return query;
        } };
      },
      select(selector) {
        canvasSelectors.push(selector);
        return { fields() {
          const index = selector === "#photo" ? 0 : selector === "#upload" ? 1 : -1;
          queries.push(() => index >= 0 && canvasPresent[index] ? { node: canvases[index] } : null);
          return query;
        } };
      },
      // exec returns one entry PER QUERY; selectAll's entry is itself an array.
      exec(fn) {
        const complete = () => fn(queries.map((read) => read()));
        if (deferCanvasQuery) canvasCallbacks.push(complete);
        else complete();
      }
    };
    return query;
  };
  page.onReady();
  page.wait = async () => {};
  return {
    page, platform, files, requests, canvases, draws, saved, canvasPresent, canvasSelectors, timers, updates,
    flushCanvasQueries() { canvasCallbacks.splice(0).forEach((complete) => complete()); },
    advanceTime(ms) { clock += ms; },
    fireTimers() {
      Array.from(timers.entries()).forEach(([id, callback]) => {
        if (timers.delete(id)) callback();
      });
    }
  };
}

test("page initializes canvases without requiring a successful connection", () => {
  const { page, canvases, canvasSelectors } = pageFixture();
  assert.equal(page.data.connected, false);
  assert.equal(page.canvas, canvases[0]);
  assert.equal(page.uploadCanvas, canvases[1]);
  assert.equal(page.data.canvasReady, true);
  assert.equal(page.data.canvasLoading, false);
  assert.deepEqual(canvasSelectors, ["#photo", "#upload"]);
  const wxml = readFileSync(new URL("../miniprogram/pages/matting/matting.wxml", import.meta.url), "utf8");
  assert.ok(!wxml.includes('<view wx:if="{{connected}}">'));
  assert.ok(!wxml.includes('hidden="{{!connected}}"'));
  page.onUnload();
});

test("connecting while native canvas query is pending cannot silently enable photo selection", async () => {
  const { page, requests, flushCanvasQueries } = pageFixture({ deferCanvasQuery: true, fakeTimers: true });
  await page.connect();
  page.data.consent = true;
  assert.equal(page.data.connected, true);
  assert.equal(page.data.canvasReady, false);
  await page.choosePhoto();
  assert.match(page.data.canvasError, /初始化/);
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
  flushCanvasQueries();
  assert.equal(page.data.canvasReady, true);
  assert.equal(page.data.canvasError, "");
  await page.choosePhoto();
  assert.equal(page.data.hasResult, true, page.data.error);
  page.onUnload();
  await new Promise((resolve) => setImmediate(resolve));
});

test("missing upload canvas stays visible after connection and can be retried without losing identity", async () => {
  const f = pageFixture({ deferCanvasQuery: true, fakeTimers: true });
  f.canvasPresent[1] = false;
  f.flushCanvasQueries();
  assert.equal(f.page.data.canvasReady, false);
  assert.match(f.page.data.canvasError, /重新初始化画布/);
  await f.page.connect();
  assert.equal(f.page.data.connected, true);
  assert.match(f.page.data.canvasError, /重新初始化画布/);
  f.page.data.consent = true;
  await f.page.choosePhoto();
  assert.equal(f.requests.filter((request) => request.method === "POST").length, 0);
  f.canvasPresent[1] = true;
  f.page.retryCanvas();
  f.flushCanvasQueries();
  assert.equal(f.page.data.canvasReady, true);
  assert.equal(f.page.data.tokenText, "");
  await f.page.choosePhoto();
  assert.equal(f.page.data.hasResult, true, f.page.data.error);
  f.page.onUnload();
  await new Promise((resolve) => setImmediate(resolve));
});

test("canvas timeout is visible and late native callback cannot overwrite failure or a new attempt", () => {
  const f = pageFixture({ deferCanvasQuery: true, fakeTimers: true });
  f.fireTimers();
  assert.equal(f.page.data.canvasReady, false);
  assert.equal(f.page.data.canvasLoading, false);
  assert.match(f.page.data.canvasError, /重新初始化画布/);
  f.flushCanvasQueries();
  assert.equal(f.page.data.canvasReady, false);
  f.page.retryCanvas();
  f.flushCanvasQueries();
  assert.equal(f.page.data.canvasReady, true);
  assert.equal(f.timers.size, 0);
  f.page.onUnload();
});

test("a late canvas callback after unload never attaches nodes or updates the page", () => {
  const f = pageFixture({ deferCanvasQuery: true, fakeTimers: true });
  let writes = 0;
  f.page.setData = () => { writes++; };
  f.page.onUnload();
  f.flushCanvasQueries();
  f.fireTimers();
  assert.equal(writes, 0);
  assert.equal(f.page.canvas, null);
  assert.equal(f.page.uploadCanvas, null);
  assert.equal(f.timers.size, 0);
});

test("unsupported upload context fails initialization rather than crashing during photo processing", () => {
  const f = pageFixture();
  f.canvases[1].getContext = () => null;
  f.page.retryCanvas();
  assert.equal(f.page.data.canvasReady, false);
  assert.match(f.page.data.canvasError, /初始化失败/);
  assert.equal(f.page.canvas, null);
  assert.equal(f.page.uploadCanvas, null);
  f.page.onUnload();
});

test("photo click without a model connection has an explicit message", async () => {
  const { page, requests } = pageFixture();
  page.data.consent = true;
  await page.choosePhoto();
  assert.match(page.data.error, /检查真实模型与连接/);
  assert.equal(requests.length, 0);
  page.onUnload();
});

test("UI keeps canvas errors independent and requires canvas readiness for the photo button", () => {
  const wxml = readFileSync(new URL("../miniprogram/pages/matting/matting.wxml", import.meta.url), "utf8");
  assert.match(wxml, /bindtap="choosePhoto" disabled="{{[^"]*!canvasReady/);
  assert.match(wxml, /wx:if="{{canvasError}}"/);
  assert.match(wxml, /bindtap="retryCanvas"/);
});

test("page refuses photo transmission until connection and per-photo authorization", async () => {
  const { page, requests } = pageFixture();
  await page.connect();
  await page.choosePhoto();
  assert.match(page.data.error, /本人|授权/);
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
  assert.equal(page.data.tokenText, "");
  page.onUnload();
});

test("page processes bounded photo, changes background locally, exports result not original", async () => {
  const { page, requests, files, draws, canvases } = pageFixture();
  await page.connect();
  page.data.consent = true;
  await page.choosePhoto();
  assert.equal(page.data.hasResult, true, page.data.error);
  assert.ok(canvases[1].width * canvases[1].height <= 1048576);
  assert.ok(Math.max(canvases[1].width, canvases[1].height) <= 1280);
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  page.changeControl({ currentTarget: { dataset: { key: "backgroundIndex" } }, detail: { value: "2" } });
  assert.equal(draws.filter((draw) => draw.canvas === 0 && draw.fill).at(-1).fill, "#D93434");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  page.toggleOriginal();
  assert.equal(page.data.showOriginal, true);
  await page.exportPhoto();
  assert.equal(page.data.showOriginal, false);
  assert.ok(page.data.evidence, page.data.error);
  assert.equal(page.data.evidence.width, 295);
  assert.equal(page.data.evidence.height, 413);
  assert.notEqual(draws.filter((draw) => draw.canvas === 0 && draw.image).at(-1).image, "/original.jpg");
  page.onUnload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(files.size, 0);
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
});

test("backend model failure clears processing label, blocks export and permits retry", async () => {
  const f = pageFixture();
  await f.page.connect();
  f.page.data.consent = true;
  const request = f.platform.request;
  f.platform.request = (args) => {
    if (args.method === "GET" && args.url.includes("/jobs/")) {
      args.success({ statusCode: 200, data: {
        ...result("failed"), width: f.canvases[1].width, height: f.canvases[1].height,
        errorCode: "MODEL_FAILED"
      } });
      return { abort() {} };
    }
    return request(args);
  };
  await f.page.choosePhoto();
  assert.equal(f.page.data.hasResult, false);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.processing, false);
  assert.match(f.page.data.stateText, /处理失败/);
  assert.ok(!f.page.data.stateText.includes("处理中"));
  assert.match(f.page.data.error, /后端运行日志/);
  await f.page.exportPhoto();
  await f.page.save();
  assert.equal(f.saved.length, 0);
  f.platform.request = request;
  await f.page.choosePhoto();
  assert.equal(f.page.data.hasResult, true, f.page.data.error);
  f.page.onUnload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.files.size, 0);
});

test("progress follows real stages and is hidden with timers released on success", async () => {
  const f = pageFixture({ fakeTimers: true });
  await f.page.connect();
  f.page.data.consent = true;
  const request = f.platform.request;
  const states = ["queued", "processing", "ready"];
  f.platform.request = (args) => {
    if (args.method === "GET" && args.url.includes("/jobs/")) {
      args.success({ statusCode: 200, data: {
        ...result(states.shift()), width: f.canvases[1].width, height: f.canvases[1].height
      } });
      return { abort() {} };
    }
    return request(args);
  };
  await f.page.choosePhoto();
  const stages = f.updates.filter((data) => data.progressTitle).map((data) => data.progressTitle);
  assert.deepEqual(stages, [
    "准备照片副本", "上传照片副本", "排队等待抠图", "真实模型抠图中", "下载抠图结果", "检查结果并生成预览"
  ]);
  assert.equal(f.page.data.hasResult, true, f.page.data.error);
  assert.equal(f.page.data.progressVisible, false);
  assert.equal(f.page.data.progressStep, 0);
  assert.equal(f.page.progressTimer, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests.filter((args) => args.method === "POST").length, 1);
  f.page.onUnload();
  await new Promise((resolve) => setImmediate(resolve));
});

test("progress starts only after photo selection and measures elapsed time not completion", async () => {
  const f = pageFixture({ fakeTimers: true });
  await f.page.connect();
  f.page.data.consent = true;
  let picker, poll;
  f.platform.chooseMedia = (args) => { picker = args; };
  const request = f.platform.request;
  f.platform.request = (args) => {
    if (args.method === "GET" && args.url.includes("/jobs/")) {
      poll = args;
      return { abort() {} };
    }
    return request(args);
  };
  const pending = f.page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(picker);
  assert.equal(f.page.data.progressVisible, false);
  assert.equal(f.timers.size, 0);
  f.advanceTime(10000);
  picker.success({ tempFiles: [{ tempFilePath: "/original.jpg", size: 1000 }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(poll);
  assert.equal(f.page.data.progressVisible, true);
  assert.equal(f.page.data.progressStep, 2);
  assert.equal(f.page.data.elapsedSeconds, 0);
  f.advanceTime(31000);
  f.fireTimers();
  assert.equal(f.page.data.elapsedSeconds, 31);
  assert.equal(f.page.data.progressSlow, true);
  assert.equal(f.page.data.progressStep, 2);
  f.page.cancelProcessing();
  await pending;
  assert.equal(f.page.data.progressVisible, false);
  assert.equal(f.page.data.elapsedSeconds, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.page.data.stateText, "已取消处理");
  f.page.onUnload();
});

test("elapsed clock spans queue and model stages without inventing a percent", () => {
  const f = pageFixture({ fakeTimers: true });
  f.page.setData({ processing: true });
  f.page.updateProcessingStage("queued", f.page.generation);
  assert.equal(f.page.data.progressStep, 3);
  f.advanceTime(5000);
  f.fireTimers();
  assert.equal(f.page.data.elapsedSeconds, 5);
  f.page.updateProcessingStage("processing", f.page.generation);
  assert.match(f.page.data.progressHint, /未提供完成百分比/);
  f.advanceTime(3000);
  f.fireTimers();
  assert.equal(f.page.data.elapsedSeconds, 8);
  assert.equal(f.timers.size, 1);
  const title = f.page.data.progressTitle;
  f.page.updateProcessingStage("unknown-stage", f.page.generation);
  f.page.updateProcessingStage("__proto__", f.page.generation);
  f.page.updateProcessingStage("download", f.page.generation + 1);
  assert.equal(f.page.data.progressTitle, title);
  f.page.stopProcessingProgress();
  assert.equal(f.timers.size, 0);
  f.page.onUnload();
});

test("cancelling stops animation/clock immediately and blocks late download success", async () => {
  const f = pageFixture({ fakeTimers: true });
  await f.page.connect();
  f.page.data.consent = true;
  let download;
  f.platform.downloadFile = (args) => { download = args; return { abort() {} }; };
  const pending = f.page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(download);
  assert.equal(f.page.data.progressTitle, "下载抠图结果");
  const lateTick = Array.from(f.timers.values())[0];
  f.page.cancelProcessing();
  assert.equal(f.page.data.progressVisible, false);
  assert.equal(f.page.data.cancelRequested, true);
  assert.equal(f.page.data.processing, false);
  assert.equal(f.timers.size, 0);
  const writes = f.updates.length;
  f.advanceTime(10000);
  lateTick();
  assert.equal(f.updates.length, writes);
  await pending;
  download.success({ statusCode: 200, filePath: download.filePath });
  assert.equal(f.page.data.hasResult, false);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.stateText, "已取消处理");
  assert.equal(f.saved.length, 0);
  assert.equal(f.files.size, 0);
  f.page.onUnload();
});

test("model failure and timeout both release progress timers and remain unsavable", async () => {
  for (const code of ["MODEL_FAILED", "TIMEOUT"]) {
    const f = pageFixture({ fakeTimers: true });
    await f.page.connect();
    f.page.data.consent = true;
    const request = f.platform.request;
    f.platform.request = (args) => {
      if (args.method === "GET" && args.url.includes("/jobs/")) {
        args.success({ statusCode: 200, data: {
          ...result("failed"), errorCode: code, width: f.canvases[1].width, height: f.canvases[1].height
        } });
        return { abort() {} };
      }
      return request(args);
    };
    await f.page.choosePhoto();
    assert.equal(f.page.data.progressVisible, false);
    assert.equal(f.page.data.hasResult, false);
    assert.equal(f.timers.size, 0);
    assert.match(f.page.data.stateText, /处理失败/);
    f.page.onUnload();
  }
});

test("unload releases the progress clock and ignores native callbacks without page writes", async () => {
  const f = pageFixture({ fakeTimers: true });
  await f.page.connect();
  f.page.data.consent = true;
  let download;
  f.platform.downloadFile = (args) => { download = args; return { abort() {} }; };
  const pending = f.page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  const lateTick = Array.from(f.timers.values())[0];
  const writes = f.updates.length;
  f.page.onUnload();
  lateTick();
  await pending;
  download.success({ statusCode: 200, filePath: download.filePath });
  assert.equal(f.updates.length, writes);
  assert.equal(f.page.progressTimer, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.page.canvas, null);
});

test("retry after cancellation restarts the clock and ignores the previous attempt's timer", async () => {
  const f = pageFixture({ fakeTimers: true });
  await f.page.connect();
  f.page.data.consent = true;
  let firstDownload;
  const download = f.platform.downloadFile;
  f.platform.downloadFile = (args) => { firstDownload = args; return { abort() {} }; };
  const first = f.page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  const oldTick = Array.from(f.timers.values())[0];
  f.advanceTime(20000);
  f.fireTimers();
  f.page.cancelProcessing();
  await first;
  assert.equal(f.page.data.elapsedSeconds, 0);
  let secondDownload;
  f.platform.downloadFile = (args) => { secondDownload = args; return { abort() {} }; };
  const second = f.page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.page.data.cancelRequested, false);
  assert.equal(f.page.data.progressVisible, true);
  assert.equal(f.page.data.elapsedSeconds, 0);
  const writes = f.updates.length;
  oldTick();
  firstDownload.success({ statusCode: 200, filePath: firstDownload.filePath });
  assert.equal(f.updates.length, writes);
  download(secondDownload);
  await second;
  assert.equal(f.page.data.hasResult, true, f.page.data.error);
  assert.equal(f.page.data.progressVisible, false);
  assert.equal(f.timers.size, 0);
  f.page.onUnload();
});

test("processing UI uses an indeterminate bar with true stages and slow-wait text, not a percentage", () => {
  const wxml = readFileSync(new URL("../miniprogram/pages/matting/matting.wxml", import.meta.url), "utf8");
  const wxss = readFileSync(new URL("../miniprogram/pages/matting/matting.wxss", import.meta.url), "utf8");
  assert.match(wxml, /wx:if="{{progressVisible}}" class="processing-progress"/);
  assert.match(wxml, /已等待 {{elapsedSeconds}} 秒/);
  assert.match(wxml, /wx:if="{{progressSlow}}"/);
  for (const stage of ["准备照片", "上传副本", "模型抠图", "结果预览"]) assert.ok(wxml.includes(stage));
  assert.ok(!wxml.includes("percent="));
  assert.match(wxss, /animation: matting-wait 1\.6s linear infinite/);
});

test("managed cleanup does not delete original or active cutout and retries failures", async () => {
  const { platform, files } = pageFixture();
  const managed = new ManagedFiles(platform);
  const path = managed.reserve("png");
  files.set(path, { bytes: 10 });
  files.set("/original.jpg", { bytes: 10 });
  await managed.sweep();
  assert.ok(files.has(path));
  const fs = platform.getFileSystemManager();
  const unlink = fs.unlink;
  fs.unlink = (args) => args.fail({ errMsg: "unlink:fail permission denied /private/secret" });
  assert.equal(await managed.remove(path), false);
  assert.ok(managed.failures.has(path));
  fs.unlink = unlink;
  assert.equal(await managed.remove(path), true);
  assert.ok(files.has("/original.jpg"));
});

for (const formatIndex of [0, 1]) {
  test(`full page exports and saves verified ${formatIndex ? "PNG" : "JPEG"} after local blue background`, async () => {
    const { page, files, saved, draws, requests } = pageFixture();
    await page.connect();
    page.data.consent = true;
    await page.choosePhoto();
    page.changeControl({ currentTarget: { dataset: { key: "backgroundIndex" } }, detail: { value: 1 } });
    page.changeControl({ currentTarget: { dataset: { key: "formatIndex" } }, detail: { value: formatIndex } });
    await page.exportPhoto();
    assert.ok(page.data.evidence, page.data.error);
    assert.equal(page.data.evidence.format, formatIndex ? "png" : "jpeg");
    assert.equal(page.data.evidence.width, 295);
    assert.equal(page.data.evidence.height, 413);
    assert.equal(draws.filter((draw) => draw.canvas === 0 && draw.fill).at(-1).fill, "#438EDB");
    await page.save();
    assert.deepEqual(saved, [page.outputPath]);
    assert.ok(files.has(page.outputPath));
    assert.equal(requests.filter((item) => item.method === "POST").length, 1);
    page.onUnload();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test("failed export verification never calls album saving", async () => {
  const { page, platform, saved } = pageFixture();
  await page.connect();
  page.data.consent = true;
  await page.choosePhoto();
  const original = platform.getImageInfo;
  platform.getImageInfo = (args) => {
    original({ ...args, success: (result) => args.success({ ...result, width: 10 }) });
  };
  await page.exportPhoto();
  assert.equal(page.data.evidence, null);
  await page.save();
  assert.equal(saved.length, 0);
  page.onUnload();
  await new Promise((resolve) => setImmediate(resolve));
});

test("album permission failure keeps a validated output for an explicit retry", async () => {
  const { page, platform, saved } = pageFixture();
  await page.connect();
  page.data.consent = true;
  await page.choosePhoto();
  await page.exportPhoto();
  const output = page.outputPath;
  const original = platform.saveImageToPhotosAlbum;
  platform.saveImageToPhotosAlbum = (args) => args.fail({ errMsg: "permission denied" });
  await page.save();
  assert.match(page.data.error, /相册权限/);
  assert.equal(page.outputPath, output);
  assert.ok(page.data.evidence);
  assert.equal(saved.length, 0);
  platform.saveImageToPhotosAlbum = original;
  await page.save();
  assert.deepEqual(saved, [output]);
  page.onUnload();
  await new Promise((resolve) => setImmediate(resolve));
});

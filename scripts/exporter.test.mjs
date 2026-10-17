import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadLab } from "./helpers/load-lab.mjs";

const require = createRequire(import.meta.url);
const { MAX_LAB_BYTES, parseByteRange, exportWithConstraints } = require("../miniprogram/utils/exporter.js");
const { createLogger } = require("../miniprogram/utils/logger.js");
const { reserveExportPath, releaseExportPath, isMissingFile, findAbandonedExports } =
  require("../miniprogram/utils/export-files.js");
const pixels = { width: 295, height: 413 };
const jpeg = { format: "jpeg", minBytes: null, maxBytes: null };

function fixture({ sizes = [150], info = { ...pixels, type: "jpeg" }, ...options } = {}) {
  const created = [];
  const removed = [];
  const inspected = [];
  return {
    created, removed, inspected,
    config: {
      canvas: { ...pixels }, pixels, file: jpeg,
      async createFile(args) {
        created.push(args);
        return `private-temp-${created.length}`;
      },
      async inspectFile(path) {
        inspected.push(path);
        return { info, bytes: sizes[inspected.length - 1] ?? sizes.at(-1) };
      },
      async releaseFile(path) { removed.push(path); return true; },
      ...options
    }
  };
}

test("byte input uses exact positive integers, inclusive bounds and blank means unlimited", () => {
  assert.deepEqual(parseByteRange("", " "), { minBytes: null, maxBytes: null });
  assert.deepEqual(parseByteRange("100", "100"), { minBytes: 100, maxBytes: 100 });
  assert.deepEqual(parseByteRange(" 1 ", String(MAX_LAB_BYTES)), { minBytes: 1, maxBytes: MAX_LAB_BYTES });
  assert.deepEqual(parseByteRange("", "20000"), { minBytes: null, maxBytes: 20000 });
});

test("byte input rejects decimals, scientific notation, negatives, inverted and oversized ranges", () => {
  for (const invalid of ["0", "-1", "1.5", "1e4", "20KB", "Infinity", String(MAX_LAB_BYTES + 1), null, 10]) {
    assert.throws(() => parseByteRange(invalid, ""), /INVALID_EXPORT/);
    assert.throws(() => parseByteRange("", invalid), /INVALID_EXPORT/);
  }
  assert.throws(() => parseByteRange("200", "100"), /INVALID_EXPORT/);
});

test("unconstrained JPEG keeps original quality and exports exactly once", async () => {
  const f = fixture();
  const result = await exportWithConstraints(f.config);
  assert.equal(result.path, "private-temp-1");
  assert.equal(result.attempts, 1);
  assert.equal(result.quality, 0.92);
  assert.equal(result.bytes, 150);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].fileType, "jpg");
  assert.deepEqual(f.removed, []);
});

test("bounded JPEG search discards oversize candidates and retains the first verified fit", async () => {
  const f = fixture({ sizes: [250, 220, 200], file: { ...jpeg, minBytes: 100, maxBytes: 200 } });
  const result = await exportWithConstraints(f.config);
  assert.equal(result.attempts, 3);
  assert.equal(result.bytes, 200);
  assert.deepEqual(f.removed, ["private-temp-1", "private-temp-2"]);
  assert.ok(f.created.every((args) => args.destWidth === 295 && args.destHeight === 413));
  assert.ok(f.created[0].quality > f.created[1].quality && f.created[1].quality > f.created[2].quality);
});

test("JPEG lower-byte endpoint is inclusive", async () => {
  const f = fixture({ sizes: [100], file: { ...jpeg, minBytes: 100, maxBytes: 200 } });
  assert.equal((await exportWithConstraints(f.config)).bytes, 100);
});

test("JPEG search does not assume encoder sizes are monotonic", async () => {
  const f = fixture({ sizes: [80, 250, 150], file: { ...jpeg, minBytes: 100, maxBytes: 200 } });
  assert.equal((await exportWithConstraints(f.config)).attempts, 3);
  assert.equal(f.removed.length, 2);
});

test("oversize JPEG stops at eight attempts without shrinking pixels or going below quality floor", async () => {
  const f = fixture({ sizes: [300], file: { ...jpeg, maxBytes: 200 } });
  await assert.rejects(exportWithConstraints(f.config), /EXPORT_SIZE_OUT_OF_BOUNDS/);
  assert.equal(f.created.length, 8);
  assert.equal(f.removed.length, 8);
  assert.equal(f.created.at(-1).quality, 0.55);
  assert.ok(f.created.every((args) => args.destWidth === 295 && args.destHeight === 413 && args.quality >= 0.55));
});

test("under-minimum JPEG fails rather than padding a file", async () => {
  const f = fixture({ sizes: [50], file: { ...jpeg, minBytes: 100 } });
  await assert.rejects(exportWithConstraints(f.config), /EXPORT_SIZE_OUT_OF_BOUNDS/);
  assert.equal(f.created.length, 8);
  assert.equal(f.removed.length, 8);
});

test("PNG is verified but never quality-searched", async () => {
  const f = fixture({
    sizes: [150], info: { ...pixels, type: "png" },
    file: { format: "png", minBytes: 100, maxBytes: 200 }
  });
  const result = await exportWithConstraints(f.config);
  assert.equal(result.attempts, 1);
  assert.equal(result.quality, null);
  assert.equal(f.created[0].fileType, "png");
});

test("PNG out of bounds cleans its file and fails after a single encoding", async () => {
  const f = fixture({
    sizes: [300], info: { ...pixels, type: "png" },
    file: { format: "png", minBytes: null, maxBytes: 200 }
  });
  await assert.rejects(exportWithConstraints(f.config), /EXPORT_SIZE_OUT_OF_BOUNDS/);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.removed, ["private-temp-1"]);
});

test("DPR does not multiply final dimensions for any lab preset", async () => {
  for (const target of [pixels, { width: 600, height: 600 }, { width: 600, height: 800 }]) {
    for (const dpr of [1, 2, 3]) {
      const f = fixture({
        canvas: { width: target.width * dpr, height: target.height * dpr },
        pixels: target, info: { ...target, type: "jpeg" }
      });
      await exportWithConstraints(f.config);
      assert.equal(f.created[0].destWidth, target.width);
      assert.equal(f.created[0].destHeight, target.height);
    }
  }
});

test("dimension or format mismatch is fatal and does not trigger another encoding", async () => {
  for (const [info, code] of [
    [{ ...pixels, width: 590, type: "jpeg" }, "EXPORT_DIMENSION_MISMATCH"],
    [{ ...pixels, type: "png" }, "EXPORT_FORMAT_MISMATCH"]
  ]) {
    const f = fixture({ info, file: { ...jpeg, maxBytes: 200 } });
    await assert.rejects(exportWithConstraints(f.config), new RegExp(code));
    assert.equal(f.created.length, 1);
    assert.equal(f.removed.length, 1);
  }
});

test("zero, fractional or invalid file sizes stop export and release their file", async () => {
  for (const size of [0, -1, 1.5, Infinity, NaN]) {
    const f = fixture({ sizes: [size] });
    await assert.rejects(exportWithConstraints(f.config), /EXPORT_SIZE_INVALID/);
    assert.equal(f.removed.length, 1);
  }
});

test("read-back failure releases the generated file and does not encode again", async () => {
  const f = fixture({ async inspectFile() { throw new Error("READ_FAILED"); } });
  await assert.rejects(exportWithConstraints(f.config), /READ_FAILED/);
  assert.equal(f.created.length, 1);
  assert.equal(f.removed.length, 1);
});

test("invalid format, pixel options, byte ranges and search limits are rejected before encoding", async () => {
  for (const options of [
    { file: { ...jpeg, format: "gif" } }, { file: { ...jpeg, minBytes: 0 } },
    { file: { ...jpeg, minBytes: 201, maxBytes: 200 } }, { file: { ...jpeg, maxBytes: undefined } },
    { pixels: { width: 0, height: 413 } }, { maxAttempts: 0 }, { maxAttempts: 13 },
    { maxAttempts: 1.5 }, { minQuality: 0 }, { maxQuality: 1.1 }, { minQuality: 0.95 },
    { createFile: null }
  ]) {
    const f = fixture(options);
    await assert.rejects(exportWithConstraints(f.config), /INVALID_EXPORT/);
    assert.equal(f.created.length, 0);
  }
});

test("one-attempt and custom bounded searches obey configured limits", async () => {
  const f = fixture({ maxAttempts: 1, sizes: [300], file: { ...jpeg, maxBytes: 200 } });
  await assert.rejects(exportWithConstraints(f.config), /EXPORT_SIZE_OUT_OF_BOUNDS/);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].quality, 0.92);
  const g = fixture({
    maxAttempts: 3, minQuality: 0.7, maxQuality: 1, sizes: [300], file: { ...jpeg, maxBytes: 200 }
  });
  await assert.rejects(exportWithConstraints(g.config), /EXPORT_SIZE_OUT_OF_BOUNDS/);
  assert.deepEqual(g.created.map((args) => args.quality), [1, 0.85, 0.7]);
});

test("already-unloaded page creates no file", async () => {
  const f = fixture({ isActive: () => false });
  await assert.rejects(exportWithConstraints(f.config), /USER_CANCELLED/);
  assert.equal(f.created.length, 0);
});

test("unload while encoder resolves deletes output and skips read-back", async () => {
  let active = true;
  const f = fixture({
    isActive: () => active,
    async createFile() { active = false; return "late-private-path"; }
  });
  await assert.rejects(exportWithConstraints(f.config), /USER_CANCELLED/);
  assert.equal(f.inspected.length, 0);
  assert.deepEqual(f.removed, ["late-private-path"]);
});

test("unload during read-back never returns a savable file", async () => {
  let active = true;
  const f = fixture({
    isActive: () => active,
    async inspectFile() { active = false; return { info: { ...pixels, type: "jpeg" }, bytes: 150 }; }
  });
  await assert.rejects(exportWithConstraints(f.config), /USER_CANCELLED/);
  assert.equal(f.removed.length, 1);
});

test("cleanup failure stops further JPEG attempts", async () => {
  const f = fixture({
    sizes: [300], file: { ...jpeg, maxBytes: 200 },
    async releaseFile() { return false; }
  });
  await assert.rejects(exportWithConstraints(f.config), /TEMP_CLEANUP_FAILED/);
  assert.equal(f.created.length, 1);
});

function platform({ sizes = [150], failCleanup = false, failStat = false, failDiscovery = false, failSave = false } = {}) {
  const created = [];
  const removed = [];
  const files = new Map();
  const fs = {
    readdir(args) {
      if (failDiscovery) args.fail({ errMsg: "RAW-readdir-private-path" });
      else args.success({ files: Array.from(files.keys()).filter((path) => path.startsWith("/private-test/"))
        .map((path) => path.slice("/private-test/".length)) });
    },
    saveFile(args) {
      if (failSave) { args.fail({ errMsg: "RAW-save-private-path" }); return; }
      const file = files.get(args.tempFilePath);
      files.delete(args.tempFilePath);
      // A late encoder callback may not populate our fixture's image metadata.
      files.set(args.filePath, file || { bytes: 150, info: { ...pixels, type: "jpeg" } });
      args.success({ savedFilePath: args.filePath });
    },
    stat(args) {
      if (failStat) args.fail({ errMsg: "RAW-stat-private-path" });
      else args.success({ stats: { size: files.get(args.path).bytes } });
    },
    unlink(args) {
      removed.push(args.filePath);
      if (failCleanup) args.fail({ errMsg: "RAW-unlink-private-path" });
      else if (!files.has(args.filePath)) args.fail({ errno: 1300002 });
      else { files.delete(args.filePath); args.success({}); }
    }
  };
  return {
    created, removed, files, fs,
    setCleanupFailure(value) { failCleanup = value; },
    setDiscoveryFailure(value) { failDiscovery = value; },
    wx: {
      env: { USER_DATA_PATH: "/private-test" },
      canvasToTempFilePath(args) {
        created.push(args);
        const path = `RAW-private-path-${created.length}`;
        files.set(path, {
          bytes: sizes[created.length - 1] ?? sizes.at(-1),
          info: { width: args.destWidth, height: args.destHeight, type: args.fileType === "png" ? "png" : "jpeg" }
        });
        args.success({ tempFilePath: path });
      },
      getImageInfo(args) { args.success(files.get(args.src).info); },
      getFileSystemManager() { return fs; }
    }
  };
}

function readyPage(p) {
  const page = loadLab(p.wx);
  page.canvas = { ...pixels };
  page.image = {};
  page.source = { width: 400, height: 600 };
  page.context = { fillRect() {}, drawImage() {} };
  page.draw = () => {};
  return page;
}

test("lab integrates exact byte constraints and publishes evidence only after a verified fit", async () => {
  const p = platform({ sizes: [250, 150] });
  const page = readyPage(p);
  page.data.minBytesText = "100";
  page.data.maxBytesText = "200";
  await page.exportPhoto();
  assert.equal(page.data.error, "");
  assert.equal(page.data.busy, false);
  assert.equal(page.data.evidence.bytes, 150);
  assert.equal(page.data.evidence.attempts, 2);
  assert.equal(page.data.evidence.minBytes, 100);
  assert.equal(page.data.evidence.maxBytes, 200);
  assert.equal(page.ownedExports.size, 1);
  assert.ok(page.ownedExports.has(page.outputPath));
  assert.equal(p.files.size, 1);
});

test("lab PNG option is an actual PNG export with a one-attempt failure message when oversized", async () => {
  const p = platform({ sizes: [300] });
  const page = readyPage(p);
  page.data.formatIndex = 1;
  page.data.maxBytesText = "200";
  await page.exportPhoto();
  assert.equal(p.created[0].fileType, "png");
  assert.equal(p.created.length, 1);
  assert.match(page.data.error, /PNG/);
  assert.equal(page.data.evidence, null);
  assert.equal(page.outputPath, null);
  assert.equal(page.ownedExports.size, 0);
});

test("lab shows bounded JPEG failure and does not expose saving when no candidate fits", async () => {
  const p = platform({ sizes: [300] });
  const page = readyPage(p);
  page.data.maxBytesText = "200";
  await page.exportPhoto();
  assert.equal(p.created.length, 8);
  assert.match(page.data.error, /8 次/);
  assert.equal(page.data.evidence, null);
  assert.equal(page.outputPath, null);
  assert.equal(page.ownedExports.size, 0);
  assert.equal(p.files.size, 0);
});

test("lab validates inverted byte range before invoking the encoder", async () => {
  const p = platform();
  const page = readyPage(p);
  page.data.minBytesText = "200";
  page.data.maxBytesText = "100";
  await page.exportPhoto();
  assert.equal(p.created.length, 0);
  assert.equal(page.data.evidence, null);
  assert.match(page.data.error, /整数/);
});

test("lab read-back failure cleans output and keeps save unavailable", async () => {
  const p = platform({ failStat: true });
  const page = readyPage(p);
  await page.exportPhoto();
  assert.equal(page.data.evidence, null);
  assert.equal(page.ownedExports.size, 0);
  assert.equal(p.files.size, 0);
});

test("lab cleanup failure remains tracked, pauses encoding and can be retried successfully", async () => {
  const p = platform({ sizes: [300], failCleanup: true });
  const page = readyPage(p);
  page.data.maxBytesText = "200";
  await page.exportPhoto();
  assert.equal(p.created.length, 1);
  assert.equal(page.data.cleanupPending, 1);
  assert.equal(page.ownedExports.size, 1);
  await page.exportPhoto();
  assert.equal(p.created.length, 1);
  assert.equal(page.data.cleanupPending, 1);
  p.setCleanupFailure(false);
  await page.retryCleanupAction();
  assert.equal(page.data.cleanupPending, 0);
  assert.equal(page.ownedExports.size, 0);
  assert.equal(page.data.error, "");
});

test("concurrent cleanup calls deduplicate and keep ownership until unlink succeeds", async () => {
  let unlinkCalls = 0;
  let finish;
  const page = loadLab({
    getFileSystemManager() { return { unlink(args) { unlinkCalls++; finish = args.success; } }; }
  });
  page.ownedExports.add("owned-private-path");
  const first = page.removeExport("owned-private-path");
  const second = page.removeExport("owned-private-path");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(page.ownedExports.size, 1);
  assert.equal(unlinkCalls, 1);
  finish({});
  assert.equal(await first, true);
  assert.equal(page.ownedExports.size, 0);
  assert.equal(page.cleanupJobs.size, 0);
});

test("cleanup never unlinks unowned photos", async () => {
  const page = loadLab({ getFileSystemManager() { throw new Error("must not be called"); } });
  assert.equal(await page.removeExport("original-photo"), true);
});

test("changing format, constraints, crop or preset invalidates and releases the old export", async () => {
  for (const [method, event] of [
    ["changeFormat", { detail: { value: "1" } }],
    ["changeByteRange", { currentTarget: { dataset: { key: "maxBytesText" } }, detail: { value: "200" } }],
    ["changeTransform", { currentTarget: { dataset: { key: "zoom" } }, detail: { value: 120 } }],
    ["changePreset", { detail: { value: "1" } }],
    ["reset", undefined]
  ]) {
    const p = platform();
    const page = readyPage(p);
    await page.exportPhoto();
    page[method](event);
    assert.equal(page.outputPath, null);
    assert.equal(page.data.evidence, null);
    await page.retryCleanup();
    assert.equal(page.ownedExports.size, 0);
    assert.equal(p.files.size, 0);
  }
});

test("busy and malformed controls cannot change a running export configuration", () => {
  const page = readyPage(platform());
  page.data.busy = true;
  page.changeFormat({ detail: { value: "1" } });
  page.changePreset({ detail: { value: "1" } });
  page.changeTransform({ currentTarget: { dataset: { key: "zoom" } }, detail: { value: 200 } });
  page.changeByteRange({ currentTarget: { dataset: { key: "maxBytesText" } }, detail: { value: "100" } });
  page.reset();
  assert.equal(page.data.formatIndex, 0);
  assert.equal(page.data.presetIndex, 0);
  assert.equal(page.data.zoom, 100);
  assert.equal(page.data.maxBytesText, "");
  page.data.busy = false;
  page.changeFormat({ detail: { value: "9" } });
  page.changePreset({ detail: { value: "-1" } });
  page.changeTransform({ currentTarget: { dataset: { key: "zoom" } }, detail: { value: NaN } });
  assert.equal(page.data.formatIndex, 0);
  assert.equal(page.data.presetIndex, 0);
  assert.equal(page.data.zoom, 100);
});

test("unload during encoding releases the late output without publishing evidence", async () => {
  const p = platform();
  let complete;
  p.wx.canvasToTempFilePath = (args) => { complete = args.success; };
  const page = readyPage(p);
  const exporting = page.exportPhoto();
  // Flush only asynchronous microtasks, not a real-time delay.
  for (let i = 0; i < 10 && !complete; i++) await Promise.resolve();
  assert.ok(complete);
  page.onUnload();
  complete({ tempFilePath: "late-private-file" });
  await exporting;
  assert.equal(page.data.evidence, null);
  assert.equal(page.ownedExports.size, 0);
  assert.equal(p.removed.length, 1);
  assert.ok(p.removed[0].startsWith("/private-test/nanyiphoto-export-"));
  assert.equal(p.files.size, 0);
});

test("unload releases owned files but never updates detached page data", async () => {
  const p = platform();
  const page = readyPage(p);
  await page.exportPhoto();
  page.setData = () => { throw new Error("detached page"); };
  page.onUnload();
  await Promise.all(page.cleanupJobs.values());
  assert.equal(page.ownedExports.size, 0);
  assert.equal(p.files.size, 0);
});

test("export diagnostics retain bounded quality and attempt evidence without raw paths", () => {
  const logger = createLogger({ enabled: true, sink() {} });
  logger.emit("lab.export_completed", "INFO", { quality: 0.8142857, attempts: 3, path: "RAW-private-path" });
  assert.equal(logger.snapshot()[0].quality, 0.814);
  assert.equal(logger.snapshot()[0].attempts, 3);
  assert.ok(!JSON.stringify(logger.snapshot()).includes("RAW-private-path"));
  for (const quality of [0, -1, 1.1, Infinity, NaN]) {
    logger.emit("lab.export_completed", "INFO", { quality });
    assert.equal(logger.snapshot().at(-1).quality, undefined);
  }
});

test("abandoned-file discovery only selects the reserved namespace and excludes active exports", async () => {
  const root = "/private-test";
  const active = reserveExportPath(root, "jpeg");
  const abandoned = reserveExportPath(root, "png");
  releaseExportPath(abandoned);
  const names = [
    active.slice(root.length + 1), abandoned.slice(root.length + 1), "original-photo.jpg",
    "nanyiphoto-export-other.jpg", "../nanyiphoto-export-abc-12345678-1.jpg", null
  ];
  const fs = { readdir(args) { args.success({ files: names }); } };
  try {
    assert.deepEqual(await findAbandonedExports(fs, root), [abandoned]);
  } finally { releaseExportPath(active); }
});

test("reserved export filenames are unique and reject invalid root or format", () => {
  const first = reserveExportPath("/private-test", "jpeg");
  const second = reserveExportPath("/private-test", "jpeg");
  assert.notEqual(first, second);
  assert.match(first, /^\/private-test\/nanyiphoto-export-[a-z0-9]+-[a-z0-9]{8}-\d+\.jpg$/);
  releaseExportPath(first);
  releaseExportPath(second);
  assert.throws(() => reserveExportPath("", "jpeg"), /INVALID_EXPORT/);
  assert.throws(() => reserveExportPath("/private-test", "gif"), /INVALID_EXPORT/);
});

test("missing-file cleanup is idempotent without treating permission errors as success", async () => {
  assert.equal(isMissingFile({ errno: 1300002 }), true);
  assert.equal(isMissingFile({ errno: 1301112 }), true);
  assert.equal(isMissingFile({ errMsg: "unlink:fail no such file or directory RAW-private" }), true);
  assert.equal(isMissingFile({ errno: 1300014, errMsg: "unlink:fail permission denied RAW-private" }), false);
  assert.equal(isMissingFile({ errMsg: "RAW-no such file" }), false);
  const p = platform();
  const page = readyPage(p);
  page.ownedExports.add("/private-test/already-removed");
  assert.equal(await page.removeExport("/private-test/already-removed"), true);
  assert.equal(page.ownedExports.size, 0);
  assert.equal(page.data.cleanupPending, 0);
});

test("a new export sweeps abandoned private intermediates but leaves unrelated files untouched", async () => {
  const p = platform();
  const stale = reserveExportPath("/private-test", "jpeg");
  releaseExportPath(stale);
  p.files.set(stale, { bytes: 150, info: { ...pixels, type: "jpeg" } });
  p.files.set("/private-test/original-photo.jpg", { bytes: 150 });
  const page = readyPage(p);
  await page.exportPhoto();
  assert.ok(p.removed.includes(stale));
  assert.equal(p.files.has(stale), false);
  assert.equal(p.files.has("/private-test/original-photo.jpg"), true);
  assert.ok(page.outputPath.startsWith("/private-test/nanyiphoto-export-"));
  page.onUnload();
  await Promise.all(page.cleanupJobs.values());
  assert.equal(p.files.size, 1);
});

test("directory discovery failure blocks encoding and can be explicitly retried", async () => {
  const p = platform({ failDiscovery: true });
  const page = readyPage(p);
  await page.exportPhoto();
  assert.equal(p.created.length, 0);
  assert.equal(page.data.cleanupBlocked, true);
  p.setDiscoveryFailure(false);
  await page.retryCleanupAction();
  assert.equal(page.data.cleanupBlocked, false);
  assert.equal(page.data.error, "");
});

test("save-to-private-storage failure never exposes a savable output or leaves an owned destination", async () => {
  const p = platform({ failSave: true });
  const page = readyPage(p);
  await page.exportPhoto();
  assert.equal(p.created.length, 1);
  assert.equal(page.outputPath, null);
  assert.equal(page.data.evidence, null);
  assert.equal(page.ownedExports.size, 0);
  // Unmoved temporary files are managed by WeChat, not writable private exports.
  assert.equal(Array.from(p.files.keys()).filter((path) => path.startsWith("/private-test/")).length, 0);
});

test("unload during private-file save cleans the file after its move completes", async () => {
  const p = platform();
  const originalSave = p.fs.saveFile;
  let finishSave;
  p.fs.saveFile = (args) => { finishSave = () => originalSave(args); };
  const page = readyPage(p);
  const exporting = page.exportPhoto();
  for (let i = 0; i < 20 && !finishSave; i++) await Promise.resolve();
  assert.ok(finishSave);
  assert.equal(page.ownedExports.size, 0);
  page.onUnload();
  finishSave();
  await exporting;
  assert.equal(page.data.evidence, null);
  assert.equal(page.ownedExports.size, 0);
  assert.equal(p.files.size, 0);
});

test("quality rounding never escapes a custom quality floor or ceiling", async () => {
  const f = fixture({
    sizes: [300], file: { ...jpeg, maxBytes: 200 }, minQuality: 0.5504, maxQuality: 0.9204
  });
  await assert.rejects(exportWithConstraints(f.config), /EXPORT_SIZE_OUT_OF_BOUNDS/);
  assert.ok(f.created.every((args) => args.quality >= 0.5504 && args.quality <= 0.9204));
});

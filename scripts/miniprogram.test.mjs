import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
const require = createRequire(import.meta.url);
const { cropTransform, exportOptions, verifyExport } = require("../miniprogram/utils/geometry.js");
const { createApi } = require("../miniprogram/services/api.js");

test("crop covers the canvas at all allowed pan and zoom extremes", () => {
  for (const source of [[400, 600], [1200, 600], [600, 1200]]) {
    for (const target of [[295, 413], [600, 600], [600, 800]]) {
      for (const zoom of [1, 2, 3]) for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) {
        const result = cropTransform(...source, ...target, zoom, x, y);
        assert.ok(result.x <= 0 && result.y <= 0);
        assert.ok(result.x + result.width >= target[0] - 1e-9);
        assert.ok(result.y + result.height >= target[1] - 1e-9);
      }
    }
  }
});
test("invalid transformations are rejected", () => {
  for (const dimensions of [[0, 100], [-1, 100], [NaN, 100]]) {
    assert.throws(() => cropTransform(...dimensions, 295, 413));
  }
  assert.throws(() => cropTransform(400, 600, 295, 413, 0.5));
  assert.throws(() => cropTransform(400, 600, 295, 413, 1, 2));
});
test("DPR never changes exported specification dimensions", () => {
  for (const dpr of [1, 2, 3]) {
    const canvas = { width: 295 * dpr, height: 413 * dpr };
    const options = exportOptions(canvas, { width: 295, height: 413 });
    assert.equal(options.destWidth, 295);
    assert.equal(options.destHeight, 413);
    assert.equal(options.fileType, "jpg");
  }
});
test("read-back verification checks dimensions, format and byte boundaries", () => {
  const pixels = { width: 295, height: 413 };
  const info = { ...pixels, type: "jpeg" };
  const file = { format: "jpeg", minBytes: 100, maxBytes: 200 };
  assert.ok(verifyExport(info, 100, pixels, file));
  assert.ok(verifyExport(info, 200, pixels, file));
  assert.throws(() => verifyExport({ ...info, width: 590 }, 150, pixels, file));
  assert.throws(() => verifyExport({ ...info, type: "png" }, 150, pixels, file));
  assert.throws(() => verifyExport(info, 99, pixels, file));
  assert.throws(() => verifyExport(info, 201, pixels, file));
});
test("local API refuses missing development identity", async () => {
  await assert.rejects(createApi({ transport: "local", baseUrl: "http://127.0.0.1" }).getSpecs(), /TOKEN_NOT_CONFIGURED/);
});
test("API error does not become success and has no automatic paid retries", async () => {
  let calls = 0;
  globalThis.wx = { request(args) {
    calls++;
    args.success({ statusCode: 503, data: { error: { code: "PROVIDERS_NOT_CONFIGURED" } } });
  } };
  const api = createApi({ transport: "local", baseUrl: "http://127.0.0.1", developmentToken: "fixture-test-token" });
  await assert.rejects(api.getSpecs(), /PROVIDERS_NOT_CONFIGURED/);
  assert.equal(calls, 1);
  delete globalThis.wx;
});
test("privacy component resolves rejection on detach", () => {
  let definition;
  const context = createContext({ Component(value) { definition = value; } });
  new Script(readFileSync(new URL("../miniprogram/components/privacy-consent/privacy-consent.js", import.meta.url), "utf8")).runInContext(context);
  let decision;
  const component = { setData() {} };
  definition.methods.requestAuthorization.call(component, (value) => { decision = value.event; });
  definition.lifetimes.detached.call(component);
  assert.equal(decision, "disagree");
});
test("bundled example specs remain disabled drafts", () => {
  const catalog = require("../miniprogram/data/specs.js");
  assert.ok(catalog.specs.every((spec) => spec.enabled === false && spec.verification === "draft"));
});

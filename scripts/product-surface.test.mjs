import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const presets = require("../miniprogram/data/photo-presets.js");
const app = JSON.parse(readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8"));
const home = readFileSync(new URL("../miniprogram/pages/home/home.wxml", import.meta.url), "utf8");
const other = readFileSync(new URL("../miniprogram/pages/other/other.wxml", import.meta.url), "utf8");
const lab = readFileSync(new URL("../miniprogram/pages/lab/lab.wxml", import.meta.url), "utf8");

test("common print presets have unique IDs, 300-DPI pixels, and remain within local processing limits", () => {
  assert.equal(presets.length, 5);
  assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length);
  for (const preset of presets) {
    assert.ok(Number.isInteger(preset.widthMM) && preset.widthMM > 0);
    assert.ok(Number.isInteger(preset.heightMM) && preset.heightMM > 0);
    assert.equal(preset.dpi, 300);
    assert.equal(preset.width, Math.round(preset.widthMM / 25.4 * 300));
    assert.equal(preset.height, Math.round(preset.heightMM / 25.4 * 300));
    assert.ok(preset.width <= 600 && preset.height <= 800);
  }
});

test("mini-program opens the branded local editor from common sizes and keeps model comparison under Other", () => {
  assert.ok(app.pages.includes("pages/home/home"));
  assert.ok(app.pages.includes("pages/lab/lab"));
  assert.ok(app.pages.includes("pages/other/other"));
  assert.ok(app.tabBar.list.some((item) => item.pagePath === "pages/other/other" && item.text === "其他"));
  assert.match(home, /南一科技/);
  assert.match(home, /南一证件照/);
  assert.match(home, /wx:for="\{\{presets\}\}"/);
  assert.doesNotMatch(home, /开发工具|实验室|草稿|自用/);
  assert.match(other, /本地与私有模型对比/);
  assert.match(other, /照片副本/);
  assert.match(other, /最长保留 10 分钟/);
  assert.match(lab, /minKilobytesText/);
  assert.match(lab, /JPEG 或 PNG/);
  assert.match(lab, /brushMode === 'erase' \? 'selected' : ''/);
  assert.match(lab, /brushMode === 'restore' \? 'selected' : ''/);
  assert.match(lab, /brushMode === 'none' \? 'selected' : ''/);
  assert.match(lab, /class="repair-mode-button/);
});

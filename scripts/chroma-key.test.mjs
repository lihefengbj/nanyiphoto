import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAX_CHROMA_PIXELS,
  parseHexColor,
  toHexColor,
  createAlphaMask,
  compositeImageData,
  paintMask
} = require("../miniprogram/utils/chroma-key.js");

function image(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function setPixel(source, x, y, color) {
  const offset = (y * source.width + x) * 4;
  source.data.set([...color, 255], offset);
}

test("hex colors are parsed and formatted strictly", () => {
  assert.deepEqual(parseHexColor("#00aBcD"), [0, 171, 205]);
  assert.equal(toHexColor([0, 171, 205]), "#00ABCD");
  for (const invalid of ["#abc", "00ff00", "#gg0000", null]) {
    assert.throws(() => parseHexColor(invalid), /INVALID_CHROMA_COLOR/);
  }
  assert.throws(() => toHexColor([256, 0, 0]), /INVALID_CHROMA_COLOR/);
});

test("only edge-connected pixels close to the sampled background are removed", () => {
  const source = image(5, 5, [238, 130, 110]);
  for (let x = 0; x < 5; x++) {
    setPixel(source, x, 0, [0, 255, 0]);
    setPixel(source, x, 4, [0, 255, 0]);
  }
  for (let y = 1; y < 4; y++) {
    setPixel(source, 0, y, [0, 255, 0]);
    setPixel(source, 4, y, [0, 255, 0]);
  }
  setPixel(source, 2, 2, [0, 255, 0]); // A same-color garment patch enclosed by the subject.
  const result = createAlphaMask(source, 5, 5, {
    keyColor: [0, 255, 0], tolerance: 0, feather: 0
  });
  assert.equal(result.removedPixels, 16);
  assert.equal(result.alpha[0], 0);
  assert.equal(result.alpha[2 * 5 + 2], 255);
});

test("tolerance removes connected lighting variation and feather softens adjacent edges", () => {
  const source = image(3, 3, [238, 130, 110]);
  setPixel(source, 0, 0, [20, 245, 12]);
  setPixel(source, 1, 0, [92, 205, 35]);
  const result = createAlphaMask(source, 3, 3, {
    keyColor: [0, 255, 0], tolerance: 36, feather: 120
  });
  assert.equal(result.alpha[0], 0);
  assert.ok(result.alpha[1] > 0 && result.alpha[1] < 255);
  assert.equal(result.alpha[4], 255);
});

test("unmatched sampled colors are reported without changing the source", () => {
  const source = image(3, 3, [180, 120, 90]);
  const result = createAlphaMask(source, 3, 3, {
    keyColor: [0, 255, 0], tolerance: 20, feather: 48
  });
  assert.equal(result.removedPixels, 0);
  assert.ok(Array.from(result.alpha).every((value) => value === 255));
});

test("keying validates dimensions, buffers, colors, thresholds and pixel budget", () => {
  const source = image(2, 2, [0, 255, 0]);
  for (const options of [
    { keyColor: [0, 255, 0], tolerance: -1 },
    { keyColor: [0, 255, 0], tolerance: 500 },
    { keyColor: [256, 0, 0], tolerance: 10 },
    { keyColor: [0, 255, 0], feather: -1 },
    { keyColor: [0, 255, 0], maxPixels: 3 }
  ]) {
    assert.throws(() => createAlphaMask(source, 2, 2, options), /INVALID_CHROMA_INPUT/);
  }
  assert.throws(() => createAlphaMask(source, 0, 2, { keyColor: [0, 255, 0] }), /INVALID_CHROMA_INPUT/);
  assert.throws(() => createAlphaMask({ ...source, data: new Uint8Array(3) }, 2, 2,
    { keyColor: [0, 255, 0] }), /INVALID_CHROMA_INPUT/);
  assert.equal(MAX_CHROMA_PIXELS, 600 * 800);
});

test("solid background composition preserves foreground and fills transparent pixels", () => {
  const source = image(2, 1, [200, 100, 50]);
  const alpha = new Uint8Array([255, 0]);
  const output = compositeImageData(source, alpha, [10, 20, 30]);
  assert.deepEqual(Array.from(output), [200, 100, 50, 255, 10, 20, 30, 255]);
});

test("semi-transparent edges blend with the selected solid background", () => {
  const source = image(1, 1, [110, 100, 90]);
  const output = compositeImageData(source, new Uint8Array([128]), [10, 20, 30]);
  assert.deepEqual(Array.from(output), [60, 60, 60, 255]);
});

test("erase and restore brushes modify only the bounded circular mask area", () => {
  const alpha = new Uint8Array(25).fill(255);
  const changed = paintMask(alpha, 5, 5, 2, 2, 1, "erase");
  assert.ok(changed > 0);
  assert.equal(alpha[12], 0);
  assert.equal(alpha[0], 255);
  paintMask(alpha, 5, 5, 2, 2, 1, "restore");
  assert.equal(alpha[12], 255);
});

test("brush modes, ranges and mask dimensions are validated", () => {
  const alpha = new Uint8Array(4).fill(255);
  assert.throws(() => paintMask(alpha, 2, 2, 0, 0, 0, "erase"), /INVALID_CHROMA_BRUSH/);
  assert.throws(() => paintMask(alpha, 2, 2, 0, 0, 1, "paint"), /INVALID_CHROMA_BRUSH/);
  assert.throws(() => paintMask(alpha, 2, 2, NaN, 0, 1, "erase"), /INVALID_CHROMA_BRUSH/);
  assert.throws(() => paintMask(new Uint8Array(3), 2, 2, 0, 0, 1, "erase"), /INVALID_CHROMA_BRUSH/);
  assert.ok(paintMask(alpha, 2, 2, 0, 0, 1, "restore") >= 0);
});

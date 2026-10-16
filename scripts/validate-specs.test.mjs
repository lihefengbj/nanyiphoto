import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateSpecs } from "./validate-specs.mjs";

const fixture = JSON.parse(readFileSync(new URL("../config/specs.example.json", import.meta.url), "utf8"));
const today = "2026-10-16";
const validate = (catalog, options = {}) => validateSpecs(catalog, { today, ...options });
const clone = () => structuredClone(fixture);
const makeRelease = () => {
  const catalog = clone();
  Object.assign(catalog.specs[0], { enabled: true, verification: "verified", editingPolicy: "allowed" });
  return catalog;
};

test("disabled draft examples pass structure validation", () => {
  assert.deepEqual(validate(fixture), []);
});
test("draft examples cannot be published as an empty available catalog", () => {
  assert.match(validate(fixture, { release: true }).join("\n"), /at least one enabled/);
});
test("verified internal printing rule may be enabled after editing review", () => {
  assert.deepEqual(validate(makeRelease(), { release: true }), []);
});
test("digital target is independent of rounded printing millimetres", () => {
  const catalog = clone();
  catalog.specs[1].print = { widthMM: 51, heightMM: 51, dpi: 300 };
  assert.deepEqual(validate(catalog), []);
  assert.equal(catalog.specs[1].pixels.width, 600);
});
test("printing ratio permits millimetre conversion rounding", () => {
  const catalog = clone();
  Object.assign(catalog.specs[0].pixels, {
    width: 260, height: 378, minWidth: 260, maxWidth: 260, minHeight: 378, maxHeight: 378,
    aspectRatio: { width: 11, height: 16 }
  });
  catalog.specs[0].print = { widthMM: 22, heightMM: 32, dpi: 300 };
  assert.deepEqual(validate(catalog), []);
});
test("digital aspect ratio does not allow a one-pixel mismatch", () => {
  const catalog = clone();
  catalog.specs[1].pixels.width = 601;
  assert.match(validate(catalog).join("\n"), /exact for digital/);
});
test("explicit placement ranges pass validation", () => {
  const catalog = clone();
  catalog.specs[0].placement = { headTopRatio: { min: 0.07, max: 0.1 }, headHeightRatio: { min: 0.5, max: 0.7 } };
  assert.deepEqual(validate(catalog), []);
});
test("verified digital entry requires a checked official source and editing allowance", () => {
  const catalog = clone();
  Object.assign(catalog.specs[1], { enabled: true, verification: "verified", editingPolicy: "allowed" });
  assert.deepEqual(validate(catalog, { release: true }), []);
});

const invalidCases = [
  ["unsupported schema", (c) => { c.schemaVersion = 2; }, /schemaVersion/],
  ["blank version", (c) => { c.version = " "; }, /version/],
  ["empty specs", (c) => { c.specs = []; }, /non-empty array/],
  ["non-object entry", (c) => { c.specs[0] = null; }, /must be an object/],
  ["duplicate ID", (c) => { c.specs[1].id = c.specs[0].id; }, /id must be unique/],
  ["invalid slug", (c) => { c.specs[0].id = "../image"; }, /lowercase slug/],
  ["missing name", (c) => { delete c.specs[0].name; }, /name/],
  ["non-boolean enable flag", (c) => { c.specs[0].enabled = "false"; }, /enabled must be boolean/],
  ["unknown verification", (c) => { c.specs[0].verification = "passed"; }, /verification/],
  ["unknown usage", (c) => { c.specs[0].usage = "passport"; }, /usage/],
  ["fractional pixels", (c) => { c.specs[0].pixels.width = 295.5; }, /positive safe integer/],
  ["target outside range", (c) => { c.specs[0].pixels.maxWidth = 294; }, /within its bounds/],
  ["wrong ratio", (c) => { c.specs[0].pixels.aspectRatio = { width: 1, height: 1 }; }, /aspectRatio/],
  ["missing print dimensions", (c) => { c.specs[0].print = null; }, /print is required/],
  ["wrong print conversion", (c) => { c.specs[0].print.widthMM = 26; }, /mm\/dpi conversion/],
  ["non-numeric print dimensions", (c) => { c.specs[0].print.widthMM = "25"; }, /millimetres/],
  ["unsupported file format", (c) => { c.specs[0].file.format = "heic"; }, /file.format/],
  ["display text as byte constraint", (c) => { c.specs[0].file.maxBytes = "200KB"; }, /maxBytes/],
  ["reversed byte range", (c) => { c.specs[0].file.minBytes = 200; c.specs[0].file.maxBytes = 100; }, /byte bounds/],
  ["non-color background", (c) => { c.specs[0].backgrounds = ["white"]; }, /backgrounds/],
  ["duplicate colors ignoring case", (c) => { c.specs[0].backgrounds = ["#ffffff", "#FFFFFF"]; }, /backgrounds/],
  ["placement ratio outside bounds", (c) => {
    c.specs[0].placement = { headTopRatio: { min: 0, max: 2 }, headHeightRatio: { min: 0.5, max: 0.8 } };
  }, /placement.headTopRatio/],
  ["missing scope", (c) => { delete c.specs[0].scope; }, /scope/],
  ["invalid year", (c) => { c.specs[0].scope.year = "2026"; }, /scope.year/],
  ["missing source", (c) => { delete c.specs[0].source; }, /source/],
  ["untrusted URL scheme", (c) => { c.specs[1].source.url = "http://example.com/"; }, /HTTPS URL/],
  ["URL containing credentials", (c) => { c.specs[1].source.url = "https://user:secret@example.com/"; }, /HTTPS URL/],
  ["URL containing credentials without a username", (c) => { c.specs[1].source.url = "https://:secret@example.com/"; }, /HTTPS URL/],
  ["invalid calendar date", (c) => { c.specs[0].source.checkedAt = "2026-02-30"; }, /checkedAt/],
  ["future source check", (c) => { c.specs[0].source.checkedAt = "2026-10-17"; }, /checkedAt/],
  ["entry newer than catalog", (c) => { c.updatedAt = "2026-10-15"; }, /not newer than/],
  ["missing expiry field", (c) => { delete c.specs[0].expiresAt; }, /expiresAt/],
  ["expiry before update", (c) => { c.specs[0].expiresAt = "2026-10-15"; }, /after updatedAt/],
  ["missing notes", (c) => { delete c.specs[0].notes; }, /notes/],
  ["enabled draft", (c) => { c.specs[0].enabled = true; }, /must be verified/],
  ["enabled pending editing review", (c) => {
    Object.assign(c.specs[0], { enabled: true, verification: "verified" });
  }, /must allow this editing workflow/],
  ["enabled disallowed editing", (c) => {
    Object.assign(c.specs[0], { enabled: true, verification: "verified", editingPolicy: "disallowed" });
  }, /must allow this editing workflow/],
  ["enabled digital without official source", (c) => {
    Object.assign(c.specs[1], { enabled: true, verification: "verified", editingPolicy: "allowed" });
    c.specs[1].source.type = "internal";
  }, /official HTTPS source/]
];

for (const [name, mutate, pattern] of invalidCases) {
  test(`rejects ${name}`, () => {
    const catalog = clone();
    mutate(catalog);
    assert.match(validate(catalog).join("\n"), pattern);
  });
}
test("expired enabled entry is rejected without invalidating its historical dates", () => {
  const catalog = makeRelease();
  catalog.specs[0].expiresAt = "2026-10-17";
  assert.match(validateSpecs(catalog, { release: true, today: "2026-10-18" }).join("\n"), /has expired/);
});
test("malformed catalog values return errors rather than throwing", () => {
  for (const value of [null, undefined, [], "catalog", 1]) assert.ok(validate(value).length > 0);
});
test("malformed nested objects return errors rather than throwing", () => {
  for (const key of ["pixels", "file", "scope", "source", "print", "placement"]) {
    const catalog = clone();
    catalog.specs[0][key] = [];
    assert.ok(validate(catalog).length > 0);
  }
});

const script = fileURLToPath(new URL("./validate-specs.mjs", import.meta.url));
const runCli = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
test("CLI exits successfully in structure mode", () => {
  const result = runCli([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated 3 specs/);
});
test("CLI blocks release of disabled examples", () => {
  const result = runCli(["--release"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least one enabled/);
});
test("CLI reports unknown options with exit code 2", () => {
  const result = runCli(["--unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage/);
});
test("CLI reports missing input with exit code 2", () => {
  const result = runCli([fileURLToPath(new URL("./nonexistent-spec-fixture.json", import.meta.url))]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot validate catalog/);
});

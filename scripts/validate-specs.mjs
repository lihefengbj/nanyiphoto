import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isPositiveNumber = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const isDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
const isHttpsUrl = (value) => {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    const authority = url.href.slice(url.protocol.length + 2).split("/")[0];
    return url.protocol === "https:" && Boolean(url.hostname) && !authority.includes("@");
  } catch {
    return false;
  }
};

/**
 * Checks configuration consistency, not official photo acceptance or legal applicability.
 * Date-only fields use UTC dates; expiresAt is the first day the entry is no longer valid.
 */
export function validateSpecs(catalog, { release = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  const check = (condition, message) => {
    if (!condition) errors.push(message);
  };
  if (!isObject(catalog)) return ["catalog must be an object"];
  check(isDate(today), "validation date must be YYYY-MM-DD");
  check(catalog.schemaVersion === 1, "schemaVersion must be 1");
  check(isText(catalog.version), "version is required");
  check(isDate(catalog.updatedAt) && catalog.updatedAt <= today, "catalog.updatedAt must be a valid non-future date");
  if (!Array.isArray(catalog.specs) || catalog.specs.length === 0) {
    errors.push("specs must be a non-empty array");
    return errors;
  }

  const ids = new Set();
  for (const [index, spec] of catalog.specs.entries()) {
    const label = `specs[${index}]`;
    if (!isObject(spec)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const assert = (condition, field) => check(condition, `${label}.${field}`);
    assert(isText(spec.id) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spec.id), "id must be a lowercase slug");
    assert(!ids.has(spec.id), "id must be unique");
    ids.add(spec.id);
    assert(isText(spec.name), "name is required");
    assert(typeof spec.enabled === "boolean", "enabled must be boolean");
    assert(["draft", "verified"].includes(spec.verification), "verification must be draft or verified");
    assert(["print", "digital"].includes(spec.usage), "usage must be print or digital");
    assert(["pending_review", "allowed", "disallowed"].includes(spec.editingPolicy), "editingPolicy is invalid");
    assert(isText(spec.notes), "notes are required");
    assert(isDate(spec.updatedAt) && spec.updatedAt <= today && spec.updatedAt <= catalog.updatedAt,
      "updatedAt must be valid, non-future, and not newer than catalog.updatedAt");
    assert(spec.expiresAt === null || isDate(spec.expiresAt), "expiresAt must be null or a valid date");
    if (isDate(spec.expiresAt) && isDate(spec.updatedAt)) {
      assert(spec.expiresAt > spec.updatedAt, "expiresAt must be after updatedAt");
    }

    const pixels = spec.pixels;
    assert(isObject(pixels), "pixels must be an object");
    if (isObject(pixels)) {
      const keys = ["width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight"];
      for (const key of keys) assert(isPositiveInteger(pixels[key]), `pixels.${key} must be a positive safe integer`);
      assert(pixels.minWidth <= pixels.width && pixels.width <= pixels.maxWidth, "pixels.width must be within its bounds");
      assert(pixels.minHeight <= pixels.height && pixels.height <= pixels.maxHeight, "pixels.height must be within its bounds");
      const ratio = pixels.aspectRatio;
      assert(isObject(ratio) && isPositiveInteger(ratio.width) && isPositiveInteger(ratio.height),
        "pixels.aspectRatio must contain positive integer width and height");
      if (isObject(ratio) && isPositiveInteger(ratio.width) && isPositiveInteger(ratio.height)
          && isPositiveInteger(pixels.width) && isPositiveInteger(pixels.height)) {
        const crossWidth = pixels.width * ratio.height;
        const crossHeight = pixels.height * ratio.width;
        // Only printing rules permit rounding; a digital square must be exactly square.
        const tolerance = spec.usage === "print" ? Math.max(ratio.width, ratio.height) : 0;
        assert(Number.isSafeInteger(crossWidth) && Number.isSafeInteger(crossHeight)
          && Math.abs(crossWidth - crossHeight) <= tolerance,
        "pixels target must match aspectRatio (exact for digital, within one pixel for print)");
      }
    }

    const print = spec.print;
    assert(print === null || isObject(print), "print must be null or an object");
    if (spec.usage === "print") assert(isObject(print), "print is required for print usage");
    if (isObject(print)) {
      assert(isPositiveNumber(print.widthMM) && isPositiveNumber(print.heightMM), "print millimetres must be positive finite numbers");
      assert(isPositiveInteger(print.dpi), "print.dpi must be a positive safe integer");
      if (spec.usage === "print" && isObject(pixels) && isPositiveNumber(print.widthMM)
          && isPositiveNumber(print.heightMM) && isPositiveInteger(print.dpi)) {
        assert(pixels.width === Math.round(print.widthMM / 25.4 * print.dpi)
          && pixels.height === Math.round(print.heightMM / 25.4 * print.dpi),
        "print target must match rounded mm/dpi conversion");
      }
    }

    const file = spec.file;
    assert(isObject(file), "file must be an object");
    if (isObject(file)) {
      assert(["jpeg", "png"].includes(file.format), "file.format must be jpeg or png");
      for (const key of ["minBytes", "maxBytes"]) {
        assert(file[key] === null || isPositiveInteger(file[key]), `file.${key} must be null or a positive safe integer`);
      }
      if (isPositiveInteger(file.minBytes) && isPositiveInteger(file.maxBytes)) {
        assert(file.minBytes <= file.maxBytes, "file byte bounds must be ordered");
      }
    }
    assert(Array.isArray(spec.backgrounds) && spec.backgrounds.length > 0
      && spec.backgrounds.every((value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value))
      && new Set(spec.backgrounds.map((value) => value.toUpperCase())).size === spec.backgrounds.length,
    "backgrounds must contain unique #RRGGBB values");
    assert(spec.placement === null || isObject(spec.placement), "placement must be null or an object");
    if (isObject(spec.placement)) {
      for (const key of ["headTopRatio", "headHeightRatio"]) {
        const range = spec.placement[key];
        assert(isObject(range) && Number.isFinite(range.min) && Number.isFinite(range.max)
          && range.min >= 0 && range.min <= range.max && range.max <= 1,
        `placement.${key} must be an ordered ratio range within 0..1`);
      }
    }

    const scope = spec.scope;
    assert(isObject(scope), "scope must be an object");
    if (isObject(scope)) {
      assert(isText(scope.region) && isText(scope.channel), "scope.region and scope.channel are required");
      assert(scope.year === null || (Number.isInteger(scope.year) && scope.year >= 1900 && scope.year <= 9999),
        "scope.year must be null or a valid year");
    }
    const source = spec.source;
    assert(isObject(source), "source must be an object");
    if (isObject(source)) {
      assert(["internal", "official"].includes(source.type), "source.type must be internal or official");
      assert(isText(source.title), "source.title is required");
      assert(source.url === null || isHttpsUrl(source.url), "source.url must be null or an HTTPS URL without credentials");
      if (source.type === "official") assert(isHttpsUrl(source.url), "official source requires an HTTPS URL");
      assert(isDate(source.checkedAt) && source.checkedAt <= today && source.checkedAt <= spec.updatedAt,
        "source.checkedAt must be valid, non-future, and no later than updatedAt");
    }
    if (spec.enabled === true) {
      assert(spec.verification === "verified", "enabled specs must be verified");
      assert(spec.editingPolicy === "allowed", "enabled specs must allow this editing workflow");
      assert(spec.expiresAt === null || (isDate(spec.expiresAt) && spec.expiresAt > today), "enabled spec has expired");
      if (spec.usage === "digital") {
        assert(isObject(source) && source.type === "official" && isHttpsUrl(source.url),
          "enabled digital specs require an official HTTPS source");
      }
    }
  }
  if (release) check(catalog.specs.some((spec) => isObject(spec) && spec.enabled === true),
    "release requires at least one enabled spec");
  return errors;
}

function runCli() {
  const args = process.argv.slice(2);
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (paths.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--release")) {
    console.error("Usage: node scripts/validate-specs.mjs [--release] [catalog.json]");
    process.exitCode = 2;
    return;
  }
  const filename = paths[0] ? resolve(paths[0]) : fileURLToPath(new URL("../config/specs.example.json", import.meta.url));
  try {
    const catalog = JSON.parse(readFileSync(filename, "utf8"));
    const errors = validateSpecs(catalog, { release: args.includes("--release") });
    if (errors.length) {
      console.error(errors.map((error) => `- ${error}`).join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Validated ${catalog.specs.length} specs (${args.includes("--release") ? "release" : "structure"} mode).`);
    }
  } catch (error) {
    console.error(`Cannot validate catalog: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();

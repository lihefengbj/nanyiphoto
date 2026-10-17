const { exportOptions, verifyExport } = require("./geometry");

const MAX_LAB_BYTES = 10 * 1024 * 1024;

function validateFile(file) {
  if (!file || !["jpeg", "png"].includes(file.format)
      || ![file.minBytes, file.maxBytes].every((value) => value === null
        || (Number.isSafeInteger(value) && value > 0))
      || (file.minBytes !== null && file.maxBytes !== null && file.minBytes > file.maxBytes)) {
    throw new Error("INVALID_EXPORT");
  }
}

function parseByteRange(minimum = "", maximum = "") {
  const parse = (text) => {
    if (typeof text !== "string") throw new Error("INVALID_EXPORT");
    text = text.trim();
    if (!text) return null;
    if (!/^\d+$/.test(text)) throw new Error("INVALID_EXPORT");
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LAB_BYTES) throw new Error("INVALID_EXPORT");
    return value;
  };
  const range = { minBytes: parse(minimum), maxBytes: parse(maximum) };
  validateFile({ format: "jpeg", ...range });
  return range;
}

// Platform calls are injected so byte constraints and cleanup can be tested
// without claiming that Node fixtures exercise the WeChat encoder.
async function exportWithConstraints({
  canvas, pixels, file, createFile, inspectFile, releaseFile,
  isActive = () => true, maxAttempts = 8, minQuality = 0.55, maxQuality = 0.92
}) {
  validateFile(file);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12
      || !Number.isFinite(minQuality) || !Number.isFinite(maxQuality)
      || minQuality <= 0 || maxQuality > 1 || minQuality > maxQuality
      || ![createFile, inspectFile, releaseFile, isActive].every((value) => typeof value === "function")) {
    throw new Error("INVALID_EXPORT");
  }
  // Validate pixel/format options before creating any temporary file.
  exportOptions(canvas, pixels, file.format, maxQuality);
  const constrained = file.minBytes !== null || file.maxBytes !== null;
  const limit = file.format === "jpeg" && constrained ? maxAttempts : 1;
  for (let index = 0; index < limit; index++) {
    if (!isActive()) throw new Error("USER_CANCELLED");
    const quality = limit === 1 ? maxQuality
      : Math.min(maxQuality, Math.max(minQuality,
        Math.round((maxQuality - (maxQuality - minQuality) * index / (limit - 1)) * 1000) / 1000));
    let path;
    let result;
    let failure;
    try {
      path = await createFile(exportOptions(canvas, pixels, file.format, quality));
      if (typeof path !== "string" || !path) throw new Error("EXPORT_FAILED");
      if (!isActive()) throw new Error("USER_CANCELLED");
      const { info, bytes } = await inspectFile(path);
      if (!isActive()) throw new Error("USER_CANCELLED");
      verifyExport(info, bytes, pixels, file);
      result = { path, info, bytes, quality: file.format === "jpeg" ? quality : null, attempts: index + 1 };
    } catch (error) {
      failure = error;
    }
    if (result) return result;
    if (typeof path === "string" && path) {
      // Do not keep encoding new files when a rejected candidate cannot be deleted.
      // The owning page retains failed cleanup entries for a bounded retry.
      if (await releaseFile(path) === false) throw new Error("TEMP_CLEANUP_FAILED");
    }
    if (!failure || failure.message !== "EXPORT_SIZE_OUT_OF_BOUNDS") throw failure || new Error("EXPORT_FAILED");
  }
  // This is failure within the measured quality range, not proof of global impossibility.
  throw new Error("EXPORT_SIZE_OUT_OF_BOUNDS");
}

module.exports = { MAX_LAB_BYTES, parseByteRange, exportWithConstraints };

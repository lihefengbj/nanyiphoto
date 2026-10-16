function cropTransform(sourceWidth, sourceHeight, targetWidth, targetHeight, zoom = 1, panX = 0.5, panY = 0.5) {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every((value) => Number.isFinite(value) && value > 0)
      || !Number.isFinite(zoom) || zoom < 1 || zoom > 3
      || ![panX, panY].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("INVALID_TRANSFORM");
  }
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight) * zoom;
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: -(width - targetWidth) * panX, y: -(height - targetHeight) * panY, width, height };
}

function exportOptions(canvas, pixels, format = "jpeg", quality = 0.92) {
  if (!["jpeg", "png"].includes(format) || !pixels || !Number.isInteger(pixels.width)
      || !Number.isInteger(pixels.height) || pixels.width <= 0 || pixels.height <= 0
      || !Number.isFinite(quality) || quality <= 0 || quality > 1) throw new Error("INVALID_EXPORT");
  return {
    canvas, x: 0, y: 0, width: canvas.width, height: canvas.height,
    destWidth: pixels.width, destHeight: pixels.height,
    fileType: format === "jpeg" ? "jpg" : "png", quality
  };
}

function verifyExport(info, size, pixels, file) {
  if (info.width !== pixels.width || info.height !== pixels.height) throw new Error("EXPORT_DIMENSION_MISMATCH");
  if (info.type !== file.format) throw new Error("EXPORT_FORMAT_MISMATCH");
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("EXPORT_SIZE_INVALID");
  if ((file.minBytes !== null && size < file.minBytes) || (file.maxBytes !== null && size > file.maxBytes)) {
    throw new Error("EXPORT_SIZE_OUT_OF_BOUNDS");
  }
  return true;
}

module.exports = { cropTransform, exportOptions, verifyExport };

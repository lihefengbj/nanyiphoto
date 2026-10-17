const MAX_CHROMA_PIXELS = 600 * 800;
const MAX_COLOR_DISTANCE = Math.sqrt(3 * 255 * 255);

function validDimension(value) {
  return Number.isInteger(value) && value > 0;
}

function validColor(color) {
  return Array.isArray(color) && color.length === 3
    && color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
}

function parseHexColor(value) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("INVALID_CHROMA_COLOR");
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ];
}

function toHexColor(color) {
  if (!validColor(color)) throw new Error("INVALID_CHROMA_COLOR");
  return `#${color.map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function colorDistanceSquared(data, offset, keyColor) {
  const red = data[offset] - keyColor[0];
  const green = data[offset + 1] - keyColor[1];
  const blue = data[offset + 2] - keyColor[2];
  return red * red + green * green + blue * blue;
}

function createAlphaMask(imageData, width, height, {
  keyColor, tolerance = 60, feather = 48, maxPixels = MAX_CHROMA_PIXELS
} = {}) {
  const count = width * height;
  if (!validDimension(width) || !validDimension(height) || !Number.isSafeInteger(count)
      || !Number.isInteger(maxPixels) || maxPixels < 1 || count > maxPixels
      || !imageData || !imageData.data || imageData.data.length !== count * 4
      || !validColor(keyColor) || !Number.isFinite(tolerance) || tolerance < 0
      || tolerance > MAX_COLOR_DISTANCE || !Number.isFinite(feather) || feather < 0
      || feather > MAX_COLOR_DISTANCE) {
    throw new Error("INVALID_CHROMA_INPUT");
  }

  const data = imageData.data;
  const background = new Uint8Array(count);
  const queue = new Uint32Array(count);
  const toleranceSquared = tolerance * tolerance;
  let head = 0;
  let tail = 0;

  const enqueueIfBackground = (index) => {
    if (background[index]) return;
    if (colorDistanceSquared(data, index * 4, keyColor) > toleranceSquared) return;
    background[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x++) {
    enqueueIfBackground(x);
    if (height > 1) enqueueIfBackground((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueueIfBackground(y * width);
    if (width > 1) enqueueIfBackground(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy++) {
      const nextY = y + dy;
      if (nextY < 0 || nextY >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nextX = x + dx;
        if (nextX < 0 || nextX >= width) continue;
        enqueueIfBackground(nextY * width + nextX);
      }
    }
  }

  const alpha = new Uint8Array(count);
  alpha.fill(255);
  for (let index = 0; index < count; index++) {
    if (background[index]) alpha[index] = 0;
  }

  if (feather > 0) {
    const featherEnd = tolerance + feather;
    for (let index = 0; index < count; index++) {
      if (background[index]) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      let touchesBackground = false;
      for (let dy = -1; dy <= 1 && !touchesBackground; dy++) {
        const nextY = y + dy;
        if (nextY < 0 || nextY >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          if (nextX >= 0 && nextX < width && background[nextY * width + nextX]) {
            touchesBackground = true;
            break;
          }
        }
      }
      if (!touchesBackground) continue;
      const distance = Math.sqrt(colorDistanceSquared(data, index * 4, keyColor));
      if (distance < featherEnd) {
        alpha[index] = Math.max(0, Math.min(255, Math.round(((distance - tolerance) / feather) * 255)));
      }
    }
  }

  return { alpha, removedPixels: tail };
}

function compositeImageData(imageData, alpha, backgroundColor) {
  if (!imageData || !imageData.data || !validDimension(imageData.width) || !validDimension(imageData.height)
      || alpha === null || alpha === undefined || alpha.length !== imageData.width * imageData.height
      || !validColor(backgroundColor)) {
    throw new Error("INVALID_CHROMA_INPUT");
  }
  const output = new Uint8ClampedArray(imageData.data.length);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    const offset = pixel * 4;
    const foregroundAlpha = (alpha[pixel] / 255) * (imageData.data[offset + 3] / 255);
    const backgroundAlpha = 1 - foregroundAlpha;
    output[offset] = Math.round(imageData.data[offset] * foregroundAlpha + backgroundColor[0] * backgroundAlpha);
    output[offset + 1] = Math.round(imageData.data[offset + 1] * foregroundAlpha
      + backgroundColor[1] * backgroundAlpha);
    output[offset + 2] = Math.round(imageData.data[offset + 2] * foregroundAlpha
      + backgroundColor[2] * backgroundAlpha);
    output[offset + 3] = 255;
  }
  return output;
}

function paintMask(alpha, width, height, x, y, radius, mode) {
  const count = width * height;
  if (!validDimension(width) || !validDimension(height) || alpha === null || alpha === undefined
      || alpha.length !== count || !Number.isFinite(x) || !Number.isFinite(y)
      || !Number.isFinite(radius) || radius < 1 || radius > Math.max(width, height)
      || !["erase", "restore"].includes(mode)) {
    throw new Error("INVALID_CHROMA_BRUSH");
  }
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  const minX = Math.max(0, Math.floor(centerX - radius - 1));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius + 1));
  const minY = Math.max(0, Math.floor(centerY - radius - 1));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius + 1));
  let changed = 0;
  for (let row = minY; row <= maxY; row++) {
    for (let column = minX; column <= maxX; column++) {
      const distance = Math.hypot(column - centerX, row - centerY);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (coverage === 0) continue;
      const index = row * width + column;
      const previous = alpha[index];
      alpha[index] = mode === "erase"
        ? Math.round(previous * (1 - coverage))
        : Math.round(previous + (255 - previous) * coverage);
      if (alpha[index] !== previous) changed++;
    }
  }
  return changed;
}

module.exports = {
  MAX_CHROMA_PIXELS,
  parseHexColor,
  toHexColor,
  createAlphaMask,
  compositeImageData,
  paintMask
};

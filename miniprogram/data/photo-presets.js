const PRINT_DPI = 300;
const presets = [
  { id: "one-inch", name: "一寸", widthMM: 25, heightMM: 35 },
  { id: "small-one-inch", name: "小一寸", widthMM: 22, heightMM: 32 },
  { id: "large-one-inch", name: "大一寸", widthMM: 33, heightMM: 48 },
  { id: "small-two-inch", name: "小二寸", widthMM: 35, heightMM: 45 },
  { id: "two-inch", name: "二寸", widthMM: 35, heightMM: 49 }
].map((preset) => {
  const width = Math.round(preset.widthMM / 25.4 * PRINT_DPI);
  const height = Math.round(preset.heightMM / 25.4 * PRINT_DPI);
  return {
    ...preset,
    width,
    height,
    dpi: PRINT_DPI,
    printLabel: `${preset.widthMM} × ${preset.heightMM} mm`,
    pixelLabel: `${width} × ${height} px`,
    displayName: `${preset.name}（${preset.widthMM} × ${preset.heightMM} mm）`
  };
});

module.exports = presets;

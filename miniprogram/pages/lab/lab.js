const { cropTransform, exportOptions, verifyExport } = require("../../utils/geometry");
const presets = [
  { name: "295 × 413 像素测试", width: 295, height: 413 },
  { name: "600 × 600 方形测试", width: 600, height: 600 },
  { name: "600 × 800 比例测试", width: 600, height: 800 }
];
const call = (method, args) => new Promise((resolve, reject) => method({ ...args, success: resolve, fail: reject }));

Page({
  data: {
    presets, presetIndex: 0, hasPhoto: false, zoom: 100, panX: 50, panY: 50,
    busy: false, evidence: null, error: "", permissionDenied: false, previewHeight: 378
  },
  onReady() {
    this.alive = true;
    this.ownedExports = new Set();
    this.createSelectorQuery().select("#photo").fields({ node: true, size: true }).exec((result) => {
      if (!this.alive) return;
      if (!result[0] || !result[0].node) {
        this.setData({ error: "设备不支持当前 Canvas 接口，请升级微信后再测试。" });
        return;
      }
      this.canvas = result[0].node;
      this.context = this.canvas.getContext("2d");
      this.draw();
    });
  },
  async choosePhoto() {
    if (this.data.busy || !this.canvas) return;
    this.setData({ busy: true, error: "", evidence: null });
    try {
      if (typeof wx.requirePrivacyAuthorize !== "function") throw new Error("PRIVACY_API_UNAVAILABLE");
      await call(wx.requirePrivacyAuthorize, {});
      if (!this.alive) return;
      const result = await call(wx.chooseMedia, {
        count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original"]
      });
      if (!this.alive) return;
      const photo = result.tempFiles[0];
      if (photo.size > 10 * 1024 * 1024) throw new Error("PHOTO_TOO_LARGE");
      const info = await call(wx.getImageInfo, { src: photo.tempFilePath });
      if (!["jpeg", "png"].includes(info.type)) throw new Error("FORMAT_UNSUPPORTED");
      if (info.width * info.height > 12 * 1024 * 1024) throw new Error("PHOTO_TOO_LARGE");
      // EXIF / decoder auto-rotation must be measured before supporting all orientations.
      if (info.orientation && info.orientation !== "up") throw new Error("ORIENTATION_UNVERIFIED");
      const image = this.canvas.createImage();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = info.path;
      });
      if (!this.alive) return;
      this.image = image;
      this.source = { width: info.width, height: info.height };
      this.setData({ hasPhoto: true, zoom: 100, panX: 50, panY: 50 });
      this.draw();
    } catch (error) {
      const messages = {
        PHOTO_TOO_LARGE: "图片过大，请选择 10MB、约 1200 万像素以内的照片。",
        FORMAT_UNSUPPORTED: "本阶段只验证 JPEG / PNG，请先转换格式。",
        ORIENTATION_UNVERIFIED: "该照片方向尚未验证，请使用正常朝向的 JPEG / PNG。",
        PRIVACY_API_UNAVAILABLE: "请升级微信并配置隐私保护指引后测试。"
      };
      if (this.alive) this.setData({ error: messages[error.message] || "未完成选图或隐私授权，可重新选择。" });
    } finally {
      if (this.alive) this.setData({ busy: false });
    }
  },
  changePreset(event) {
    if (this.data.busy) return;
    this.setData({ presetIndex: Number(event.detail.value), evidence: null });
    this.draw();
  },
  changeTransform(event) {
    if (this.data.busy) return;
    const key = event.currentTarget.dataset.key;
    if (!["zoom", "panX", "panY"].includes(key)) return;
    this.setData({ [key]: Number(event.detail.value), evidence: null });
    this.draw();
  },
  reset() {
    this.setData({ zoom: 100, panX: 50, panY: 50, evidence: null });
    this.draw();
  },
  draw() {
    if (!this.canvas) return;
    const target = presets[this.data.presetIndex];
    this.setData({ previewHeight: 270 * target.height / target.width });
    this.canvas.width = target.width;
    this.canvas.height = target.height;
    this.context.fillStyle = "#f0f2ec";
    this.context.fillRect(0, 0, target.width, target.height);
    if (!this.image) return;
    const transform = cropTransform(this.source.width, this.source.height, target.width, target.height,
      this.data.zoom / 100, this.data.panX / 100, this.data.panY / 100);
    this.context.drawImage(this.image, transform.x, transform.y, transform.width, transform.height);
  },
  async exportPhoto() {
    if (!this.image || this.data.busy) return;
    this.setData({ busy: true, error: "", evidence: null });
    try {
      const target = presets[this.data.presetIndex];
      const output = await call(wx.canvasToTempFilePath, exportOptions(this.canvas, target));
      this.ownedExports.add(output.tempFilePath);
      const info = await call(wx.getImageInfo, { src: output.tempFilePath });
      const stat = await call(wx.getFileSystemManager().stat.bind(wx.getFileSystemManager()), {
        path: output.tempFilePath
      });
      verifyExport(info, stat.stats.size, target, { format: "jpeg", minBytes: null, maxBytes: null });
      if (!this.alive) {
        this.removeExport(output.tempFilePath);
        return;
      }
      if (this.outputPath && this.outputPath !== output.tempFilePath) this.removeExport(this.outputPath);
      this.outputPath = output.tempFilePath;
      this.setData({
        evidence: { width: info.width, height: info.height, format: info.type, bytes: stat.stats.size },
        permissionDenied: false
      });
    } catch {
      if (this.alive) this.setData({ error: "导出或读回校验失败，未开放保存，请重试。" });
    } finally {
      if (this.alive) this.setData({ busy: false });
    }
  },
  async save() {
    if (!this.outputPath || !this.data.evidence || this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      await call(wx.saveImageToPhotosAlbum, { filePath: this.outputPath });
      if (this.alive) wx.showToast({ title: "已保存测试图片", icon: "success" });
    } catch {
      if (this.alive) this.setData({
        permissionDenied: true,
        error: "保存未完成。若相册授权被拒绝，可主动打开设置后再试；相册中的文件仍需人工检查。"
      });
    } finally {
      if (this.alive) this.setData({ busy: false });
    }
  },
  openSettings() { wx.openSetting({}); },
  removeExport(path) {
    if (!this.ownedExports.has(path)) return;
    this.ownedExports.delete(path);
    wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
  },
  onUnload() {
    this.alive = false;
    if (this.ownedExports) this.ownedExports.forEach((path) => this.removeExport(path));
    this.image = null;
    this.canvas = null;
  }
});

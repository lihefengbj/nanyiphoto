const { cropTransform } = require("../../utils/geometry");
const { parseByteRange, exportWithConstraints } = require("../../utils/exporter");
const { reserveExportPath, releaseExportPath, isMissingFile, findAbandonedExports } = require("../../utils/export-files");
const { logger, platformCode } = require("../../utils/logger");
const presets = [
  { name: "295 × 413 像素测试", width: 295, height: 413 },
  { name: "600 × 600 方形测试", width: 600, height: 600 },
  { name: "600 × 800 比例测试", width: 600, height: 800 }
];
const formats = ["JPEG", "PNG"];
const call = (method, args) => new Promise((resolve, reject) => method({ ...args, success: resolve, fail: reject }));

Page({
  data: {
    presets, presetIndex: 0, hasPhoto: false, zoom: 100, panX: 50, panY: 50,
    busy: false, evidence: null, error: "", permissionDenied: false, previewHeight: 378,
    formats, formatIndex: 0, minBytesText: "", maxBytesText: "", cleanupPending: 0, cleanupBlocked: false
  },
  onReady() {
    this.alive = true;
    this.ownedExports = new Set();
    this.pendingCleanup = new Set();
    this.cleanupJobs = new Map();
    this.createSelectorQuery().select("#photo").fields({ node: true, size: true }).exec((result) => {
      if (!this.alive) return;
      if (!result[0] || !result[0].node) {
        logger.emit("lab.canvas_unavailable", "WARNING", { errorCode: "CANVAS_UNAVAILABLE" });
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
    this.invalidateExport();
    this.setData({ busy: true, error: "" });
    let stage = "privacy";
    try {
      if (typeof wx.requirePrivacyAuthorize !== "function") throw new Error("PRIVACY_API_UNAVAILABLE");
      await call(wx.requirePrivacyAuthorize, {});
      if (!this.alive) return;
      stage = "select";
      const result = await call(wx.chooseMedia, {
        count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original"]
      });
      if (!this.alive) return;
      const photo = result.tempFiles[0];
      if (photo.size > 10 * 1024 * 1024) throw new Error("PHOTO_TOO_LARGE");
      stage = "decode";
      const info = await call(wx.getImageInfo, { src: photo.tempFilePath });
      if (!this.alive) return;
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
      logger.emit("lab.photo_selected", "INFO", {
        width: info.width, height: info.height, bytes: photo.size, format: info.type
      });
      this.draw();
    } catch (error) {
      logger.emit("lab.photo_failed", "WARNING", { stage, errorCode: platformCode(error, "PHOTO_FAILED") });
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
    const presetIndex = Number(event.detail.value);
    if (!Number.isInteger(presetIndex) || !presets[presetIndex]) return;
    this.invalidateExport();
    this.setData({ presetIndex });
    this.draw();
  },
  changeFormat(event) {
    if (this.data.busy) return;
    const formatIndex = Number(event.detail.value);
    if (!Number.isInteger(formatIndex) || !formats[formatIndex]) return;
    this.invalidateExport();
    this.setData({ formatIndex, error: "" });
  },
  changeByteRange(event) {
    if (this.data.busy) return;
    const key = event.currentTarget.dataset.key;
    if (!["minBytesText", "maxBytesText"].includes(key)) return;
    this.invalidateExport();
    this.setData({ [key]: event.detail.value, error: "" });
  },
  invalidateExport() {
    const path = this.outputPath;
    this.outputPath = null;
    this.setData({ evidence: null, permissionDenied: false });
    if (path) this.removeExport(path);
  },
  changeTransform(event) {
    if (this.data.busy) return;
    const key = event.currentTarget.dataset.key;
    if (!["zoom", "panX", "panY"].includes(key)) return;
    const value = Number(event.detail.value);
    const minimum = key === "zoom" ? 100 : 0;
    const maximum = key === "zoom" ? 300 : 100;
    if (!Number.isFinite(value) || value < minimum || value > maximum) return;
    this.invalidateExport();
    this.setData({ [key]: value });
    this.draw();
  },
  reset() {
    if (this.data.busy) return;
    this.invalidateExport();
    this.setData({ zoom: 100, panX: 50, panY: 50 });
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
    this.invalidateExport();
    this.setData({ busy: true, error: "" });
    const started = Date.now();
    try {
      const target = presets[this.data.presetIndex];
      const file = {
        format: this.data.formatIndex === 1 ? "png" : "jpeg",
        ...parseByteRange(this.data.minBytesText, this.data.maxBytesText)
      };
      await this.collectAbandonedExports();
      await this.retryCleanup();
      if (!this.alive) return;
      if (this.pendingCleanup.size) throw new Error("TEMP_CLEANUP_FAILED");
      const output = await exportWithConstraints({
        canvas: this.canvas, pixels: target, file, isActive: () => this.alive,
        createFile: async (options) => {
          const result = await call(wx.canvasToTempFilePath, options);
          if (!result || typeof result.tempFilePath !== "string" || !result.tempFilePath) {
            throw new Error("EXPORT_FAILED");
          }
          // Temporary directories are not general writable storage. Move the
          // candidate into our reserved private namespace before managing deletion.
          const path = reserveExportPath(wx.env.USER_DATA_PATH, file.format);
          try {
            const fs = wx.getFileSystemManager();
            await call(fs.saveFile.bind(fs), { tempFilePath: result.tempFilePath, filePath: path });
            this.ownedExports.add(path);
          } catch {
            this.ownedExports.add(path);
            await this.removeExport(path);
            throw new Error("EXPORT_FAILED");
          }
          return path;
        },
        inspectFile: async (path) => {
          const info = await call(wx.getImageInfo, { src: path });
          const fs = wx.getFileSystemManager();
          const stat = await call(fs.stat.bind(fs), { path });
          return { info, bytes: stat.stats.size };
        },
        releaseFile: (path) => this.removeExport(path)
      });
      if (!this.alive) {
        await this.removeExport(output.path);
        return;
      }
      this.outputPath = output.path;
      this.setData({
        evidence: {
          width: output.info.width, height: output.info.height, format: output.info.type, bytes: output.bytes,
          attempts: output.attempts, quality: output.quality, minBytes: file.minBytes, maxBytes: file.maxBytes
        },
        permissionDenied: false
      });
      logger.emit("lab.export_completed", "INFO", {
        width: output.info.width, height: output.info.height, format: output.info.type, bytes: output.bytes,
        attempts: output.attempts, quality: output.quality,
        durationMs: Math.max(0, Date.now() - started)
      });
    } catch (error) {
      logger.emit("lab.export_failed", "WARNING", {
        stage: "export", errorCode: platformCode(error, "EXPORT_FAILED"),
        durationMs: Math.max(0, Date.now() - started)
      });
      const messages = {
        INVALID_EXPORT: "字节限制须为 1–10485760 的整数，最小值不能大于最大值；留空表示不限。",
        EXPORT_SIZE_OUT_OF_BOUNDS: this.data.formatIndex === 1
          ? "PNG 文件大小不符合范围，未开放保存。PNG 不做质量压缩，可调整限制或选择 JPEG。"
          : "在最多 8 次、质量 0.55–0.92 的测试范围内未找到合格文件，未开放保存。请调整字节限制。",
        TEMP_CLEANUP_FAILED: "临时文件清理未完成，已暂停导出。请先重试清理。",
        EXPORT_DIMENSION_MISMATCH: "导出文件像素与目标不一致，未开放保存。",
        EXPORT_FORMAT_MISMATCH: "导出文件实际格式不符，未开放保存。"
      };
      if (this.alive) this.setData({ error: messages[error.message] || "导出或读回校验失败，未开放保存，请重试。" });
    } finally {
      if (this.alive) this.setData({ busy: false });
    }
  },
  async save() {
    if (!this.outputPath || !this.data.evidence || this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      await call(wx.saveImageToPhotosAlbum, { filePath: this.outputPath });
      logger.emit("lab.save_completed");
      if (this.alive) wx.showToast({ title: "已保存测试图片", icon: "success" });
    } catch (error) {
      logger.emit("lab.save_failed", "WARNING", { stage: "save", errorCode: platformCode(error, "SAVE_FAILED") });
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
    if (!this.ownedExports.has(path)) return Promise.resolve(true);
    if (this.cleanupJobs.has(path)) return this.cleanupJobs.get(path);
    // Defer the call one microtask so synchronous wx test callbacks cannot race the map insertion.
    const job = Promise.resolve().then(async () => {
      try {
        const fs = wx.getFileSystemManager();
        await call(fs.unlink.bind(fs), { filePath: path });
        this.ownedExports.delete(path);
        this.pendingCleanup.delete(path);
        releaseExportPath(path);
        return true;
      } catch (error) {
        if (isMissingFile(error)) {
          this.ownedExports.delete(path);
          this.pendingCleanup.delete(path);
          releaseExportPath(path);
          return true;
        }
        this.pendingCleanup.add(path);
        logger.emit("lab.cleanup_failed", "WARNING", { stage: "cleanup", errorCode: "TEMP_CLEANUP_FAILED" });
        return false;
      } finally {
        this.cleanupJobs.delete(path);
        if (this.alive) this.setData({ cleanupPending: this.pendingCleanup.size });
      }
    });
    this.cleanupJobs.set(path, job);
    return job;
  },
  async collectAbandonedExports() {
    try {
      const fs = wx.getFileSystemManager();
      const paths = await findAbandonedExports(fs, wx.env && wx.env.USER_DATA_PATH);
      for (const path of paths) this.ownedExports.add(path);
      if (this.alive) this.setData({ cleanupBlocked: false });
    } catch {
      if (this.alive) this.setData({ cleanupBlocked: true });
      logger.emit("lab.cleanup_failed", "WARNING", { stage: "cleanup", errorCode: "TEMP_CLEANUP_FAILED" });
      throw new Error("TEMP_CLEANUP_FAILED");
    }
  },
  async retryCleanup() {
    const paths = Array.from(this.ownedExports).filter((path) => path !== this.outputPath);
    for (const path of paths) await this.removeExport(path);
  },
  async retryCleanupAction() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await this.collectAbandonedExports();
      await this.retryCleanup();
      if (this.alive) this.setData({
        error: this.pendingCleanup.size ? "仍有临时文件未清理，可再次重试或退出页面。" : ""
      });
    } catch {
      if (this.alive) this.setData({ error: "私有中间文件清扫未完成，可再次重试。" });
    } finally {
      if (this.alive) this.setData({ busy: false });
    }
  },
  onUnload() {
    this.alive = false;
    if (this.ownedExports) this.ownedExports.forEach((path) => {
      releaseExportPath(path);
      this.removeExport(path);
    });
    this.image = null;
    this.canvas = null;
  }
});

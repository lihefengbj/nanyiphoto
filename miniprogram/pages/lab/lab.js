const { cropTransform } = require("../../utils/geometry");
const { parseKilobyteRange, exportWithConstraints } = require("../../utils/exporter");
const { reserveExportPath, releaseExportPath, isMissingFile, findAbandonedExports } = require("../../utils/export-files");
const { logger, platformCode } = require("../../utils/logger");
const {
  parseHexColor, toHexColor, createAlphaMask, compositeImageData, paintMask
} = require("../../utils/chroma-key");
const presets = require("../../data/photo-presets");
const formats = ["JPEG", "PNG"];
const backgrounds = [
  { name: "白色", color: "#FFFFFF", rgb: [255, 255, 255] },
  { name: "蓝色", color: "#438EDB", rgb: [67, 142, 219] },
  { name: "红色", color: "#D93434", rgb: [217, 52, 52] }
];
const call = (method, args) => new Promise((resolve, reject) => method({ ...args, success: resolve, fail: reject }));

Page({
  data: {
    presets, presetIndex: 0, hasPhoto: false, zoom: 100, panX: 50, panY: 50,
    busy: false, evidence: null, error: "", permissionDenied: false, previewHeight: 378,
    formats, formatIndex: 0, backgrounds, backgroundIndex: 0,
    minKilobytesText: "", maxKilobytesText: "", cleanupPending: 0, cleanupBlocked: false,
    keyColorHex: "", keySampled: false, keyTolerance: 60, backgroundRemoved: false,
    brushMode: "none", brushSize: 18, pixelAccessReady: false
  },
  onLoad(query) {
    const presetIndex = presets.findIndex((preset) => preset.id === query.preset);
    if (presetIndex >= 0) this.setData({ presetIndex });
  },
  onReady() {
    this.alive = true;
    this.ownedExports = new Set();
    this.pendingCleanup = new Set();
    this.cleanupJobs = new Map();
    this.createSelectorQuery().select("#photo").fields({ node: true, size: true, rect: true }).exec((result) => {
      if (!this.alive) return;
      if (!result[0] || !result[0].node) {
        logger.emit("lab.canvas_unavailable", "WARNING", { errorCode: "CANVAS_UNAVAILABLE" });
        this.setData({ error: "设备不支持当前 Canvas 接口，请升级微信后再测试。" });
        return;
      }
      this.canvas = result[0].node;
      this.context = this.canvas.getContext("2d");
      this.canvasRect = {
        left: result[0].left, top: result[0].top,
        width: result[0].width, height: result[0].height
      };
      this.canvasDocumentLeft = result[0].left + (this.pageScrollLeft || 0);
      this.canvasDocumentTop = result[0].top + (this.pageScrollTop || 0);
      const pixelAccessReady = this.context && ["getImageData", "createImageData", "putImageData"]
        .every((method) => typeof this.context[method] === "function");
      this.setData({
        pixelAccessReady,
        ...(!pixelAccessReady
          ? { error: "此设备的 Canvas 暂不支持本地像素处理；仍可使用裁剪和导出。" }
          : {})
      });
      this.draw();
    });
  },
  onPageScroll(event) {
    if (event && Number.isFinite(event.scrollTop)) this.pageScrollTop = event.scrollTop;
    if (event && Number.isFinite(event.scrollLeft)) this.pageScrollLeft = event.scrollLeft;
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
      this.sourceImageData = null;
      this.alphaMask = null;
      this.setData({
        hasPhoto: true, zoom: 100, panX: 50, panY: 50,
        keyColorHex: "", keySampled: false, backgroundRemoved: false, brushMode: "none",
        backgroundIndex: 0, error: ""
      });
      logger.emit("lab.photo_selected", "INFO", {
        width: info.width, height: info.height, bytes: photo.size, format: info.type
      });
      this.draw();
    } catch (error) {
      logger.emit("lab.photo_failed", "WARNING", { stage, errorCode: platformCode(error, "PHOTO_FAILED") });
      const messages = {
        PHOTO_TOO_LARGE: "照片过大，请选择不超过 10MB 的图片。",
        FORMAT_UNSUPPORTED: "请选择 JPEG 或 PNG 格式的照片。",
        ORIENTATION_UNVERIFIED: "这张照片的方向暂不支持，请调整方向后再试。",
        PRIVACY_API_UNAVAILABLE: "当前微信版本暂不支持选图，请更新微信后重试。"
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
    this.invalidateKeying(true);
    this.setData({ presetIndex, error: "" });
    this.draw();
  },
  invalidateKeying(clearSample = false) {
    this.sourceImageData = null;
    this.alphaMask = null;
    this.brushing = false;
    this.setData({
      backgroundRemoved: false, brushMode: "none",
      ...(clearSample ? { keyColorHex: "", keySampled: false } : {})
    });
  },
  changeBackground(event) {
    if (this.data.busy) return;
    const backgroundIndex = Number(event.detail.value);
    if (!Number.isInteger(backgroundIndex) || !backgrounds[backgroundIndex]) return;
    this.invalidateExport();
    this.setData({ backgroundIndex, error: "" });
    this.draw();
  },
  changeKeyTolerance(event) {
    if (this.data.busy) return;
    const keyTolerance = Number(event.detail.value);
    if (!Number.isInteger(keyTolerance) || keyTolerance < 0 || keyTolerance > 180) return;
    this.invalidateExport();
    this.alphaMask = null;
    this.brushing = false;
    this.setData({ keyTolerance, backgroundRemoved: false, brushMode: "none", error: "" });
    this.draw();
  },
  changeBrushSize(event) {
    if (this.data.busy) return;
    const brushSize = Number(event.detail.value);
    if (!Number.isInteger(brushSize) || brushSize < 4 || brushSize > 60) return;
    this.setData({ brushSize });
  },
  captureSourceImageData() {
    const target = presets[this.data.presetIndex];
    this.drawOriginal();
    const pixels = this.context.getImageData(0, 0, target.width, target.height);
    this.sourceImageData = {
      width: target.width,
      height: target.height,
      data: new Uint8ClampedArray(pixels.data)
    };
    return this.sourceImageData;
  },
  canvasPoint(event) {
    const touch = event && (
      event.changedTouches && event.changedTouches[0]
      || event.touches && event.touches[0]
      || event.detail
    );
    if (!touch || !this.canvas) return null;
    let x;
    let y;
    if (Number.isFinite(touch.pageX) && Number.isFinite(touch.pageY)
        && this.canvasRect && Number.isFinite(this.canvasRect.left) && Number.isFinite(this.canvasRect.top)) {
      x = touch.pageX - (Number.isFinite(this.canvasDocumentLeft) ? this.canvasDocumentLeft : this.canvasRect.left);
      y = touch.pageY - (Number.isFinite(this.canvasDocumentTop)
        ? this.canvasDocumentTop : this.canvasRect.top);
    } else if (Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY)
        && this.canvasRect && Number.isFinite(this.canvasRect.left) && Number.isFinite(this.canvasRect.top)) {
      const pageX = touch.clientX + (this.pageScrollLeft || 0);
      const pageY = touch.clientY + (this.pageScrollTop || 0);
      x = pageX - (Number.isFinite(this.canvasDocumentLeft) ? this.canvasDocumentLeft : this.canvasRect.left);
      y = pageY - (Number.isFinite(this.canvasDocumentTop)
        ? this.canvasDocumentTop : this.canvasRect.top);
    } else if (Number.isFinite(touch.x) && Number.isFinite(touch.y)) {
      x = touch.x;
      y = touch.y;
    } else return null;
    const rect = this.canvasRect;
    const displayWidth = rect && Number.isFinite(rect.width) && rect.width > 0 ? rect.width : this.canvas.width;
    const displayHeight = rect && Number.isFinite(rect.height) && rect.height > 0 ? rect.height : this.canvas.height;
    if (x < 0 || y < 0 || x >= displayWidth || y >= displayHeight) return null;
    return {
      x: Math.min(this.canvas.width - 1, Math.floor(x * this.canvas.width / displayWidth)),
      y: Math.min(this.canvas.height - 1, Math.floor(y * this.canvas.height / displayHeight))
    };
  },
  sampleBackground(event) {
    if (!this.image || this.data.busy || this.data.brushMode !== "none") return;
    const point = this.canvasPoint(event);
    if (!point) {
      this.setData({ error: "请在照片背景区域点按取样。" });
      return;
    }
    try {
      const source = this.sourceImageData || this.captureSourceImageData();
      const sum = [0, 0, 0];
      let samples = 0;
      for (let y = Math.max(0, point.y - 2); y <= Math.min(source.height - 1, point.y + 2); y++) {
        for (let x = Math.max(0, point.x - 2); x <= Math.min(source.width - 1, point.x + 2); x++) {
          const offset = (y * source.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) sum[channel] += source.data[offset + channel];
          samples++;
        }
      }
      const color = sum.map((value) => Math.round(value / samples));
      this.invalidateExport();
      this.alphaMask = null;
      this.setData({
        keyColorHex: toHexColor(color), keySampled: true,
        backgroundRemoved: false, brushMode: "none", error: ""
      });
      this.draw();
    } catch {
      this.setData({ error: "无法读取照片像素；此设备仍可用于裁剪和导出。" });
    }
  },
  async processBackground() {
    if (!this.image || this.data.busy) return;
    if (!this.data.pixelAccessReady) {
      this.setData({ error: "此设备暂不支持本地抠图；仍可使用裁剪和导出。" });
      return;
    }
    if (!this.data.keySampled || !this.data.keyColorHex) {
      this.setData({ error: "先在预览中点按纯色背景取样，再开始本地抠图。" });
      return;
    }
    this.invalidateExport();
    this.setData({ busy: true, error: "", brushMode: "none" });
    const started = Date.now();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.alive) return;
      const source = this.sourceImageData || this.captureSourceImageData();
      const result = createAlphaMask(source, source.width, source.height, {
        keyColor: parseHexColor(this.data.keyColorHex),
        tolerance: this.data.keyTolerance,
        feather: 48
      });
      const pixelCount = source.width * source.height;
      if (result.removedPixels === 0) throw new Error("BACKGROUND_NOT_FOUND");
      if (result.removedPixels > pixelCount * 0.92) throw new Error("BACKGROUND_REMOVED_TOO_MUCH");
      this.alphaMask = result.alpha;
      this.setData({ backgroundRemoved: true, error: "" });
      this.draw();
      logger.emit("lab.local_key_completed", "INFO", {
        width: source.width, height: source.height, tolerance: this.data.keyTolerance,
        durationMs: Math.max(0, Date.now() - started)
      });
    } catch (error) {
      this.alphaMask = null;
      const errorCode = error && ["BACKGROUND_NOT_FOUND", "BACKGROUND_REMOVED_TOO_MUCH",
        "INVALID_CHROMA_INPUT", "INVALID_CHROMA_COLOR"].includes(error.message)
        ? error.message : "LOCAL_KEY_FAILED";
      logger.emit("lab.local_key_failed", "WARNING", {
        errorCode, durationMs: Math.max(0, Date.now() - started)
      });
      this.setData({
        backgroundRemoved: false,
        error: error && error.message === "BACKGROUND_NOT_FOUND"
          ? "没有找到接近取样色且连到画面边缘的背景。重新取样或提高容差后再试。"
          : error && error.message === "BACKGROUND_REMOVED_TOO_MUCH"
            ? "被识别为背景的区域过大，已撤销本次处理。降低容差或重新取样。"
            : "本地抠图未完成；请重新取样或降低照片尺寸后再试。"
      });
      this.draw();
    } finally {
      if (this.alive) this.setData({ busy: false });
    }
  },
  setBrushMode(event) {
    if (this.data.busy || !this.alphaMask) return;
    const mode = event.currentTarget.dataset.mode;
    if (!["none", "erase", "restore"].includes(mode)) return;
    this.brushing = false;
    this.setData({ brushMode: mode });
  },
  paintFromEvent(event) {
    if (!this.brushing || this.data.busy || !this.alphaMask || !this.sourceImageData) return;
    const point = this.canvasPoint(event);
    if (!point) return;
    try {
      const changed = paintMask(
        this.alphaMask, this.canvas.width, this.canvas.height,
        point.x, point.y, this.data.brushSize, this.data.brushMode
      );
      if (!changed) return;
      this.invalidateExport();
      this.draw();
    } catch {
      this.setData({ error: "修边未完成，请退出修边模式后重试。" });
    }
  },
  startBrush(event) {
    if (this.data.busy || !this.alphaMask || !["erase", "restore"].includes(this.data.brushMode)) return;
    this.brushing = true;
    this.paintFromEvent(event);
  },
  moveBrush(event) { this.paintFromEvent(event); },
  endBrush() { this.brushing = false; },
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
    if (!["minKilobytesText", "maxKilobytesText"].includes(key)) return;
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
    this.invalidateKeying(true);
    this.setData({ [key]: value, error: "" });
    this.draw();
  },
  reset() {
    if (this.data.busy) return;
    this.invalidateExport();
    this.invalidateKeying(true);
    this.setData({ zoom: 100, panX: 50, panY: 50, error: "" });
    this.draw();
  },
  drawOriginal() {
    if (!this.canvas) return;
    const target = presets[this.data.presetIndex];
    const previewHeight = 270 * target.height / target.width;
    if (this.data.previewHeight !== previewHeight) this.setData({ previewHeight });
    if (this.canvasRect && Number.isFinite(this.canvasRect.width) && this.canvasRect.width > 0) {
      this.canvasRect.height = this.canvasRect.width * target.height / target.width;
    }
    if (this.canvas.width !== target.width) this.canvas.width = target.width;
    if (this.canvas.height !== target.height) this.canvas.height = target.height;
    this.context.fillStyle = backgrounds[this.data.backgroundIndex].color;
    this.context.fillRect(0, 0, target.width, target.height);
    if (!this.image) return;
    const transform = cropTransform(this.source.width, this.source.height, target.width, target.height,
      this.data.zoom / 100, this.data.panX / 100, this.data.panY / 100);
    this.context.drawImage(this.image, transform.x, transform.y, transform.width, transform.height);
  },
  draw() {
    if (!this.canvas || !this.context) return;
    this.drawOriginal();
    if (!this.alphaMask || !this.sourceImageData) return;
    try {
      const target = presets[this.data.presetIndex];
      const data = compositeImageData(
        this.sourceImageData, this.alphaMask, backgrounds[this.data.backgroundIndex].rgb
      );
      const imageData = this.context.createImageData(target.width, target.height);
      imageData.data.set(data);
      this.context.putImageData(imageData, 0, 0);
    } catch {
      this.alphaMask = null;
      this.sourceImageData = null;
      this.setData({ backgroundRemoved: false, error: "预览重绘失败，请重新取样并处理照片。" });
    }
  },
  async exportPhoto() {
    if (this.data.busy) return;
    if (!this.image) {
      this.setData({ error: "请先拍摄或选择一张照片。" });
      return;
    }
    this.invalidateExport();
    this.setData({ busy: true, error: "" });
    const started = Date.now();
    try {
      const target = presets[this.data.presetIndex];
      const file = {
        format: this.data.formatIndex === 1 ? "png" : "jpeg",
        ...parseKilobyteRange(this.data.minKilobytesText, this.data.maxKilobytesText)
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
          kilobytes: (output.bytes / 1024).toFixed(1),
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
        INVALID_EXPORT: "文件大小须为 1–10240 KB 的整数，最小值不能大于最大值；留空表示不限。",
        EXPORT_SIZE_OUT_OF_BOUNDS: this.data.formatIndex === 1
          ? "PNG 图片无法在所设大小范围内导出，请放宽限制或改用 JPEG。"
          : "图片无法在所设大小范围内导出，请适当放宽限制后重试。",
        TEMP_CLEANUP_FAILED: "暂时无法清理编辑文件，已暂停导出。请重试。",
        EXPORT_DIMENSION_MISMATCH: "照片导出失败，请重试。",
        EXPORT_FORMAT_MISMATCH: "照片导出失败，请重试。"
      };
      if (this.alive) this.setData({ error: messages[error.message] || "照片导出失败，请重试。" });
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
      if (this.alive) wx.showToast({ title: "照片已保存", icon: "success" });
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
    this.sourceImageData = null;
    this.alphaMask = null;
    this.canvasRect = null;
    this.canvasDocumentLeft = null;
    this.canvasDocumentTop = null;
    this.brushing = false;
    this.canvas = null;
  }
});

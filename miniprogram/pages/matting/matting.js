const { cropTransform } = require("../../utils/geometry");
const { exportWithConstraints, parseByteRange } = require("../../utils/exporter");
const { ManagedFiles, call } = require("../../utils/managed-files");
const { createMattingLabClient, waitForMatting } = require("../../services/matting-lab");
const presets = require("../../data/photo-presets");
const { parseHexColor, toHexColor, createAlphaMask, compositeImageData } = require("../../utils/chroma-key");
const backgrounds = [
  { name: "白色", color: "#FFFFFF", rgb: [255, 255, 255] },
  { name: "蓝色", color: "#438EDB", rgb: [67, 142, 219] },
  { name: "红色", color: "#D93434", rgb: [217, 52, 52] }
];
const messages = {
  INVALID_LAB_CONFIG: "请输入本机或同一 Wi-Fi 的私有地址，例如 http://192.168.1.20:8000。",
  LOCAL_TOKEN_NOT_CONFIGURED: "请输入后端配置的开发令牌（至少 16 个字符）。",
  UNAUTHENTICATED: "开发令牌不正确，请核对本机后端配置。",
  MATTING_LAB_DISABLED: "后端换背景实验室未开启，请设置 NP_MATTING_LAB=true。",
  LOCAL_MODEL_NOT_CONFIGURED: "后端尚未配置真实模型权重；请先完成本机模型配置。",
  LOCAL_MODEL_REVIEW_REQUIRED: "模型来源或私有测试授权记录未通过校验，请重新配置本机实验室。",
  MODEL_RUNTIME_UNAVAILABLE: "后端模型运行库不可用，请检查 Python 环境。",
  LAB_CONSENT_REQUIRED: "请先确认使用本人或已获授权的测试照片。",
  NETWORK_FAILED: "连接失败。请确认同一 Wi-Fi、后端地址和真机调试的域名设置。",
  MODEL_FAILED: "后端真实抠图失败，未生成可保存结果。请检查后端运行日志后重试，不必反复换图。",
  TIMEOUT: "处理超时，已尝试取消；可检查后端并重试。",
  TEMP_CLEANUP_FAILED: "私有中间文件清理失败，请先重试清理。",
  EXPORT_SIZE_OUT_OF_BOUNDS: "在有限编码次数内未满足字节范围，未开放保存。请调整限制或文件格式。",
  INVALID_EXPORT: "字节限制须为 1–10485760 的整数，最小值不能大于最大值。",
  ORIENTATION_UNVERIFIED: "该照片方向尚未验证，请先使用正常朝向的 JPEG / PNG。",
  PHOTO_TOO_LARGE: "请选择 10MB、约 1200 万像素以内的 JPEG / PNG。",
  INVALID_LAB_RESULT: "后端结果不符合测试资产约定，未开放预览或保存。",
  QUEUE_FULL: "测试队列或结果存储已满，请取消旧任务或稍后再试。",
  USER_CANCELLED: "已取消本次处理。"
};
const canvasUnavailable = "画布初始化失败，请点「重新初始化画布」重试；仍失败时请检查微信版本。";
const processingStages = {
  prepare: { step: 1, title: "准备照片副本", hint: "原图留在手机，仅生成有限尺寸的处理副本。" },
  upload: { step: 2, title: "上传照片副本", hint: "正在发送到你连接的本机后端。" },
  queued: { step: 3, title: "排队等待抠图", hint: "后端已接收，等待前面的任务完成。" },
  processing: { step: 3, title: "真实模型抠图中", hint: "模型未提供完成百分比，请耐心等待；可随时取消。" },
  download: { step: 4, title: "下载抠图结果", hint: "模型已完成，正在取回透明前景。" },
  verify: { step: 4, title: "检查结果并生成预览", hint: "正在核对结果格式、尺寸和文件大小。" }
};
function errorText(error) { return messages[error && error.message] || "操作未完成，请检查连接、图片或后端后重试。"; }

Page({
  data: {
    presets, backgrounds, formats: ["JPEG", "PNG"], presetIndex: 0, backgroundIndex: 0, formatIndex: 0,
    baseUrlText: "", tokenText: "", connected: false, consent: false, busy: false, processing: false, stateText: "",
    hasPhoto: false, hasResult: false, showOriginal: false, showMode: "model", previewHeight: 378,
    zoom: 100, panX: 50, panY: 50,
    localKeyColor: "", localKeySampled: false, localResultReady: false, localTolerance: 60,
    localPixelAccessReady: false,
    minBytesText: "", maxBytesText: "", evidence: null, error: "", cleanupPending: false, modelId: "",
    canvasReady: false, canvasLoading: false, canvasError: "",
    progressVisible: false, progressStep: 0, progressTitle: "", progressHint: "",
    elapsedSeconds: 0, progressSlow: false, cancelRequested: false
  },
  onReady() {
    this.alive = true;
    this.generation = 0;
    this.files = new ManagedFiles(wx);
    this.initializeCanvases();
  },
  initializeCanvases() {
    if (!this.alive || this.data.busy || this.data.canvasLoading) return;
    const attempt = this.canvasAttempt = (this.canvasAttempt || 0) + 1;
    let finished = false;
    this.setData({ canvasReady: false, canvasLoading: true, canvasError: "" });
    const finish = (nodes) => {
      if (finished || !this.alive || this.canvasAttempt !== attempt) return;
      finished = true;
      clearTimeout(this.canvasInitTimer);
      this.canvasInitTimer = null;
      try {
        if (!Array.isArray(nodes) || nodes.length !== 2 || !nodes[0] || !nodes[1]
            || !nodes[0].node || !nodes[1].node) throw new Error("CANVAS_UNAVAILABLE");
        const photo = nodes[0].node;
        const upload = nodes[1].node;
        if ([photo, upload].some((node) => typeof node.getContext !== "function"
            || typeof node.createImage !== "function")) throw new Error("CANVAS_UNAVAILABLE");
        const context = photo.getContext("2d");
        const uploadContext = upload.getContext("2d");
        if ([context, uploadContext].some((value) => !value || typeof value.fillRect !== "function"
            || typeof value.drawImage !== "function")) throw new Error("CANVAS_UNAVAILABLE");
        this.canvas = photo;
        this.uploadCanvas = upload;
        this.context = context;
        this.canvasRect = {
          left: nodes[0].left || 0, top: nodes[0].top || 0,
          width: nodes[0].width || 270, height: nodes[0].height || 378
        };
        this.canvasDocumentLeft = this.canvasRect.left + (this.pageScrollLeft || 0);
        this.canvasDocumentTop = this.canvasRect.top + (this.pageScrollTop || 0);
        const localPixelAccessReady = ["getImageData", "createImageData", "putImageData"]
          .every((method) => typeof context[method] === "function");
        this.draw();
        this.setData({ canvasReady: true, canvasLoading: false, canvasError: "", localPixelAccessReady });
      } catch {
        this.canvas = null;
        this.uploadCanvas = null;
        this.context = null;
        this.setData({ canvasReady: false, canvasLoading: false, canvasError: canvasUnavailable });
      }
    };
    this.canvasInitTimer = setTimeout(() => finish(null), 4000);
    try {
      // exec returns one result per query; a selectAll result would be a nested array.
      // Query the named canvases independently so their roles cannot be swapped.
      const query = this.createSelectorQuery();
      query.select("#photo").fields({ node: true, size: true, rect: true });
      query.select("#upload").fields({ node: true, size: true });
      query.exec(finish);
    } catch { finish(null); }
  },
  retryCanvas() { this.initializeCanvases(); },
  editConnection(event) {
    if (this.data.busy) return;
    const key = event.currentTarget.dataset.key;
    if (!["baseUrlText", "tokenText"].includes(key)) return;
    this.setData({ [key]: event.detail.value });
  },
  async connect() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      const client = createMattingLabClient({ baseUrl: this.data.baseUrlText, token: this.data.tokenText });
      this.connectingClient = client;
      const result = await client.status();
      if (!this.alive) { client.abortAll(); return; }
      if (!result || result.developmentOnly !== true || result.moderation !== "not_performed") {
        throw new Error("INVALID_LAB_RESULT");
      }
      if (!result.ready) throw new Error(result.errorCode || "MATTING_LAB_DISABLED");
      if (!Number.isInteger(result.maxInputBytes) || result.maxInputBytes < 1
          || !Number.isInteger(result.maxInputPixels) || result.maxInputPixels < 1) throw new Error("INVALID_LAB_RESULT");
      this.client = client;
      this.connectingClient = null;
      this.limits = {
        bytes: Math.min(result.maxInputBytes, 4 * 1024 * 1024),
        pixels: Math.min(result.maxInputPixels, 1024 * 1024)
      };
      this.setData({ connected: true, tokenText: "", modelId: result.modelId, stateText: "真实模型已就绪" });
    } catch (error) { if (this.alive) this.setData({ error: errorText(error) }); }
    finally { if (this.alive) this.setData({ busy: false }); }
  },
  confirmConsent(event) { if (!this.data.busy) this.setData({ consent: event.detail.value.includes("authorized") }); },
  async invalidateExport() {
    const path = this.outputPath;
    this.outputPath = null;
    if (this.alive) this.setData({ evidence: null });
    if (path && !await this.files.remove(path)) throw new Error("TEMP_CLEANUP_FAILED");
  },
  async retireJob() {
    const id = this.jobId;
    this.jobId = null;
    if (id && this.client) {
      try { await this.client.cancel(id); }
      catch {
        this.pendingJobId = id;
        if (this.alive) this.setData({ cleanupPending: true });
      }
    }
  },
  loadImage(canvas, path) {
    return new Promise((resolve, reject) => {
      const image = canvas.createImage();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("PHOTO_FAILED"));
      image.src = path;
    });
  },
  updateProcessingStage(stage, generation) {
    const value = Object.prototype.hasOwnProperty.call(processingStages, stage) && processingStages[stage];
    if (!value || !this.alive || this.generation !== generation
        || !this.data.processing || this.data.cancelRequested) return;
    const starting = !this.data.progressVisible;
    this.setData({
      progressVisible: true, progressStep: value.step, progressTitle: value.title, progressHint: value.hint
    });
    if (!starting) return;
    this.progressStartedAt = Date.now();
    const tick = () => {
      if (!this.alive || this.generation !== generation || !this.data.progressVisible
          || !this.data.processing || this.data.cancelRequested) return;
      const seconds = Math.max(0, Math.floor((Date.now() - this.progressStartedAt) / 1000));
      this.setData({ elapsedSeconds: seconds, progressSlow: seconds >= 30 });
      this.progressTimer = setTimeout(tick, 1000);
    };
    tick();
  },
  stopProcessingProgress() {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    this.progressStartedAt = null;
    if (this.alive) this.setData({
      progressVisible: false, progressStep: 0, progressTitle: "", progressHint: "",
      elapsedSeconds: 0, progressSlow: false
    });
  },
  async choosePhoto() {
    if (!this.alive || this.data.busy) return;
    if (!this.client) { this.setData({ error: "请先检查真实模型与连接，再选择照片。" }); return; }
    if (!this.data.canvasReady || !this.canvas || !this.uploadCanvas || !this.context) {
      this.setData({ canvasError: this.data.canvasLoading ? "画布正在初始化，请稍候。" : canvasUnavailable });
      return;
    }
    if (!this.data.consent) { this.setData({ error: messages.LAB_CONSENT_REQUIRED }); return; }
    const generation = ++this.generation;
    const active = () => this.alive && this.generation === generation;
    this.setData({
      busy: true, processing: true, cancelRequested: false, error: "", stateText: "选择本人／获授权照片"
    });
    try {
      await this.invalidateExport();
      await this.retireJob();
      if (this.pendingJobId) throw new Error("NETWORK_FAILED");
      await this.files.sweep();
      await this.files.cleanup();
      if (!active()) return;
      this.cutoutImage = null;
      this.originalImage = null;
      this.cutoutPath = null;
      this.localSourceImageData = null;
      this.localAlphaMask = null;
      this.setData({
        hasResult: false, hasPhoto: false, showOriginal: false, showMode: "model",
        localKeyColor: "", localKeySampled: false, localResultReady: false
      });
      await call(wx.requirePrivacyAuthorize, {});
      if (!active()) return;
      const selected = await call(wx.chooseMedia, {
        count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original"]
      });
      if (!active()) return;
      const photo = selected.tempFiles && selected.tempFiles[0];
      if (!photo || photo.size > 10 * 1024 * 1024) throw new Error("PHOTO_TOO_LARGE");
      const info = await call(wx.getImageInfo, { src: photo.tempFilePath });
      if (!active()) return;
      if (!["jpeg", "png"].includes(info.type) || info.width * info.height > 12 * 1024 * 1024) {
        throw new Error("PHOTO_TOO_LARGE");
      }
      if (info.orientation && info.orientation !== "up") throw new Error("ORIENTATION_UNVERIFIED");
      const original = await this.loadImage(this.uploadCanvas, info.path);
      if (!active()) return;
      this.originalImage = original;
      this.originalSize = { width: info.width, height: info.height };
      this.sourceSize = this.originalSize;
      this.setData({
        hasPhoto: true, zoom: 100, panX: 50, panY: 50, showMode: "model",
        stateText: "生成有限尺寸的推理副本"
      });
      this.updateProcessingStage("prepare", generation);
      this.draw();
      const scale = Math.min(1, 1280 / Math.max(info.width, info.height),
        Math.sqrt(this.limits.pixels / (info.width * info.height)));
      this.uploadCanvas.width = Math.max(1, Math.floor(info.width * scale));
      this.uploadCanvas.height = Math.max(1, Math.floor(info.height * scale));
      const uploadContext = this.uploadCanvas.getContext("2d");
      uploadContext.fillStyle = "#FFFFFF";
      uploadContext.fillRect(0, 0, this.uploadCanvas.width, this.uploadCanvas.height);
      uploadContext.drawImage(original, 0, 0, this.uploadCanvas.width, this.uploadCanvas.height);
      const temporary = await call(wx.canvasToTempFilePath, {
        canvas: this.uploadCanvas, x: 0, y: 0, width: this.uploadCanvas.width, height: this.uploadCanvas.height,
        destWidth: this.uploadCanvas.width, destHeight: this.uploadCanvas.height, fileType: "jpg", quality: 0.92
      });
      const uploadPath = await this.files.save(temporary.tempFilePath, "jpeg");
      if (!active()) { await this.files.remove(uploadPath); return; }
      const fs = wx.getFileSystemManager();
      const stat = await call(fs.stat.bind(fs), { path: uploadPath });
      if (stat.stats.size > this.limits.bytes) throw new Error("PHOTO_TOO_LARGE");
      const binary = await call(fs.readFile.bind(fs), { filePath: uploadPath });
      if (!active()) return;
      this.setData({ stateText: "上传私有推理副本" });
      this.updateProcessingStage("upload", generation);
      const key = `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${generation}`;
      const job = await this.client.create(binary.data, key);
      if (!job || !/^[a-f0-9]{32}$/.test(job.jobId)) throw new Error("INVALID_LAB_RESULT");
      this.jobId = job.jobId;
      await this.files.remove(uploadPath);
      if (this.files.failures.size) throw new Error("TEMP_CLEANUP_FAILED");
      if (!active()) { await this.retireJob(); return; }
      const result = await waitForMatting(this.client, job.jobId, {
        active, wait: (ms) => this.wait(ms),
        onState: (state) => {
          if (!active() || !["queued", "processing"].includes(state)) return;
          this.setData({ stateText: state === "queued" ? "排队等待真实抠图" : "真实模型处理中" });
          this.updateProcessingStage(state, generation);
        }
      });
      if (!active()) return;
      this.setData({ stateText: "下载真实抠图结果" });
      this.updateProcessingStage("download", generation);
      const cutoutPath = this.files.reserve("png");
      const download = await this.client.download(job.jobId, cutoutPath);
      if (!active()) { await this.files.remove(cutoutPath); return; }
      if (download.filePath && download.filePath !== cutoutPath) throw new Error("INVALID_LAB_RESULT");
      this.setData({ stateText: "检查抠图结果并生成预览" });
      this.updateProcessingStage("verify", generation);
      const cutoutStat = await call(fs.stat.bind(fs), { path: cutoutPath });
      if (cutoutStat.stats.size < 1 || cutoutStat.stats.size > this.limits.bytes) throw new Error("INVALID_LAB_RESULT");
      const cutoutInfo = await call(wx.getImageInfo, { src: cutoutPath });
      if (cutoutInfo.type !== "png" || cutoutInfo.width !== result.width || cutoutInfo.height !== result.height) {
        throw new Error("INVALID_LAB_RESULT");
      }
      this.cutoutImage = await this.loadImage(this.canvas, cutoutPath);
      if (!active()) { this.cutoutImage = null; await this.files.remove(cutoutPath); return; }
      this.cutoutPath = cutoutPath;
      this.sourceSize = { width: result.width, height: result.height };
      this.setData({ hasResult: true, showMode: "model", stateText: "私有模型处理完成" });
      this.draw();
    } catch (error) {
      this.stopProcessingProgress();
      await this.retireJob();
      const cancelled = !active() || error && error.message === "USER_CANCELLED";
      if (this.alive) this.setData({
        error: errorText(cancelled ? new Error("USER_CANCELLED") : error), hasResult: false,
        stateText: cancelled ? "已取消处理" : "处理失败 · 未生成可保存结果"
      });
      this.cutoutImage = null;
      this.cutoutPath = null;
      if (this.alive) this.draw();
      try { await this.files.cleanup(); }
      catch { if (this.alive) this.setData({ cleanupPending: true }); }
    } finally {
      this.stopProcessingProgress();
      if (this.alive) this.setData({
        busy: false, processing: false,
        ...(!active() ? { stateText: "已取消处理" } : {})
      });
    }
  },
  wait(ms) {
    return new Promise((resolve) => {
      this.waitResolve = resolve;
      this.waitTimer = setTimeout(() => { this.waitResolve = null; this.waitTimer = null; resolve(); }, ms);
    });
  },
  cancelProcessing() {
    this.generation++;
    this.stopProcessingProgress();
    if (this.alive && this.data.processing) this.setData({
      cancelRequested: true, processing: false, stateText: "已取消 · 正在结束请求并清理"
    });
    if (this.client) this.client.abortAll();
    if (this.waitTimer) clearTimeout(this.waitTimer);
    if (this.waitResolve) this.waitResolve();
    this.waitResolve = null;
    this.waitTimer = null;
    this.retireJob();
  },
  changeControl(event) {
    if (this.data.busy) return;
    const key = event.currentTarget.dataset.key;
    const value = Number(event.detail.value);
    const valid = { presetIndex: [0, presets.length - 1], backgroundIndex: [0, 2], formatIndex: [0, 1],
      zoom: [100, 300], panX: [0, 100], panY: [0, 100] };
    if (!valid[key] || !Number.isInteger(value) || value < valid[key][0] || value > valid[key][1]) return;
    this.invalidateExport().catch(() => this.setData({ cleanupPending: true }));
    const localInvalidated = ["presetIndex", "zoom", "panX", "panY"].includes(key);
    if (localInvalidated) {
      this.localSourceImageData = null;
      this.localAlphaMask = null;
    }
    this.setData({
      [key]: value,
      showOriginal: false,
      showMode: this.data.hasResult ? "model" : "original",
      ...(localInvalidated ? { localKeyColor: "", localKeySampled: false, localResultReady: false } : {}),
      error: ""
    });
    this.draw();
  },
  changeBytes(event) {
    if (this.data.busy) return;
    const key = event.currentTarget.dataset.key;
    if (!["minBytesText", "maxBytesText"].includes(key)) return;
    this.invalidateExport().catch(() => this.setData({ cleanupPending: true }));
    this.setData({ [key]: event.detail.value, error: "" });
  },
  toggleOriginal() {
    if (this.data.busy || !this.data.hasResult) return;
    const showOriginal = !this.data.showOriginal;
    this.setData({ showOriginal, showMode: showOriginal ? "original" : "model" });
    this.draw();
  },
  onPageScroll(event) {
    if (event && Number.isFinite(event.scrollTop)) this.pageScrollTop = event.scrollTop;
    if (event && Number.isFinite(event.scrollLeft)) this.pageScrollLeft = event.scrollLeft;
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
    if (Number.isFinite(touch.pageX) && Number.isFinite(touch.pageY)) {
      x = touch.pageX - (this.canvasDocumentLeft || 0);
      y = touch.pageY - (this.canvasDocumentTop || 0);
    } else if (Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY)) {
      x = touch.clientX + (this.pageScrollLeft || 0) - (this.canvasDocumentLeft || 0);
      y = touch.clientY + (this.pageScrollTop || 0) - (this.canvasDocumentTop || 0);
    } else if (Number.isFinite(touch.x) && Number.isFinite(touch.y)) {
      x = touch.x;
      y = touch.y;
    } else return null;
    const rect = this.canvasRect || { width: this.canvas.width, height: this.canvas.height };
    const displayWidth = rect.width > 0 ? rect.width : this.canvas.width;
    const displayHeight = rect.height > 0 ? rect.height : this.canvas.height;
    if (x < 0 || y < 0 || x >= displayWidth || y >= displayHeight) return null;
    return {
      x: Math.min(this.canvas.width - 1, Math.floor(x * this.canvas.width / displayWidth)),
      y: Math.min(this.canvas.height - 1, Math.floor(y * this.canvas.height / displayHeight))
    };
  },
  sampleLocalBackground(event) {
    if (!this.data.hasPhoto || this.data.busy) return;
    if (!this.data.localPixelAccessReady) {
      this.setData({ error: "此设备暂不支持本地像素处理，无法进行结果对比。" });
      return;
    }
    const point = this.canvasPoint(event);
    if (!point) {
      this.setData({ error: "请在预览中的照片背景处点按取样。" });
      return;
    }
    try {
      const target = presets[this.data.presetIndex];
      this.draw("original");
      const pixels = this.context.getImageData(0, 0, target.width, target.height);
      const source = { width: target.width, height: target.height, data: new Uint8ClampedArray(pixels.data) };
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = Math.max(0, point.y - 2); y <= Math.min(target.height - 1, point.y + 2); y++) {
        for (let x = Math.max(0, point.x - 2); x <= Math.min(target.width - 1, point.x + 2); x++) {
          const offset = (y * target.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) sum[channel] += source.data[offset + channel];
          count++;
        }
      }
      const color = sum.map((value) => Math.round(value / count));
      this.localSourceImageData = source;
      this.localAlphaMask = null;
      const showMode = this.data.showMode;
      this.setData({
        localKeyColor: toHexColor(color), localKeySampled: true, localResultReady: false,
        showMode, error: ""
      });
      this.draw();
    } catch {
      this.setData({ error: "此设备暂不支持读取本地像素，无法生成本地对比结果。" });
    }
  },
  runLocalComparison() {
    if (this.data.busy || !this.data.hasPhoto) return;
    if (!this.data.localKeySampled || !this.localSourceImageData) {
      this.setData({ error: "先在预览中点按照片原背景取样，再生成本地结果。" });
      return;
    }
    try {
      const source = this.localSourceImageData;
      const result = createAlphaMask(source, source.width, source.height, {
        keyColor: parseHexColor(this.data.localKeyColor),
        tolerance: this.data.localTolerance,
        feather: 48
      });
      const pixelCount = source.width * source.height;
      if (result.removedPixels === 0) throw new Error("BACKGROUND_NOT_FOUND");
      if (result.removedPixels > pixelCount * 0.92) throw new Error("BACKGROUND_REMOVED_TOO_MUCH");
      this.localAlphaMask = result.alpha;
      this.setData({ localResultReady: true, showMode: "local", showOriginal: false, error: "" });
      this.draw();
    } catch (error) {
      const message = error && error.message === "BACKGROUND_NOT_FOUND"
        ? "没有找到连到画面边缘的相近背景，请重新取样或提高容差。"
        : error && error.message === "BACKGROUND_REMOVED_TOO_MUCH"
          ? "识别为背景的区域过大，请降低容差或重新取样。"
          : "本地处理未完成，请重新取样后再试。";
      this.setData({ localResultReady: false, error: message });
    }
  },
  changeLocalTolerance(event) {
    if (this.data.busy) return;
    const localTolerance = Number(event.detail.value);
    if (!Number.isInteger(localTolerance) || localTolerance < 0 || localTolerance > 180) return;
    this.localAlphaMask = null;
    this.setData({
      localTolerance, localResultReady: false, showMode: "original",
      showOriginal: true, error: ""
    });
    this.draw();
  },
  setPreviewMode(event) {
    if (this.data.busy) return;
    const mode = event.currentTarget.dataset.mode;
    if (!["original", "local", "model"].includes(mode)) return;
    if (mode === "local" && !this.data.localResultReady) return;
    if (mode === "model" && !this.data.hasResult) return;
    if (mode === "original" && !this.data.hasPhoto) return;
    this.setData({ showMode: mode, showOriginal: mode === "original" });
    this.draw();
  },
  reset() {
    if (this.data.busy) return;
    this.invalidateExport().catch(() => this.setData({ cleanupPending: true }));
    this.localSourceImageData = null;
    this.localAlphaMask = null;
    this.setData({
      zoom: 100, panX: 50, panY: 50, showOriginal: false,
      showMode: this.data.hasResult ? "model" : "original",
      localKeyColor: "", localKeySampled: false, localResultReady: false
    });
    this.draw();
  },
  draw(mode = this.data.showMode) {
    if (!this.canvas) return;
    const target = presets[this.data.presetIndex];
    this.canvas.width = target.width;
    this.canvas.height = target.height;
    this.setData({ previewHeight: 270 * target.height / target.width });
    if (this.canvasRect && this.canvasRect.width > 0) {
      this.canvasRect.height = this.canvasRect.width * target.height / target.width;
    }
    this.context.fillStyle = backgrounds[this.data.backgroundIndex].color;
    this.context.fillRect(0, 0, target.width, target.height);
    if (mode === "local" && this.localSourceImageData && this.localAlphaMask) {
      try {
        const data = compositeImageData(
          this.localSourceImageData,
          this.localAlphaMask,
          backgrounds[this.data.backgroundIndex].rgb
        );
        const imageData = this.context.createImageData(target.width, target.height);
        imageData.data.set(data);
        this.context.putImageData(imageData, 0, 0);
      } catch {
        this.setData({ error: "本地结果预览失败，请重新生成。" });
      }
      return;
    }
    const original = mode === "original" || !this.cutoutImage;
    const image = original ? this.originalImage : this.cutoutImage;
    if (!image) return;
    const size = original ? this.originalSize : this.sourceSize;
    const position = cropTransform(size.width, size.height, target.width, target.height,
      this.data.zoom / 100, this.data.panX / 100, this.data.panY / 100);
    this.context.drawImage(image, position.x, position.y, position.width, position.height);
  },
  async exportPhoto() {
    if (!this.data.hasResult || !this.cutoutImage || this.data.busy) return;
    this.setData({ busy: true, error: "", showOriginal: false, showMode: "model" });
    try {
      await this.invalidateExport();
      await this.files.sweep();
      await this.files.cleanup([this.cutoutPath]);
      if (!this.alive) return;
      this.draw("model"); // Never export a comparison view.
      const format = this.data.formatIndex === 1 ? "png" : "jpeg";
      const output = await exportWithConstraints({
        canvas: this.canvas, pixels: presets[this.data.presetIndex],
        file: { format, ...parseByteRange(this.data.minBytesText, this.data.maxBytesText) },
        isActive: () => this.alive,
        createFile: async (options) => {
          const result = await call(wx.canvasToTempFilePath, options);
          return this.files.save(result.tempFilePath, format);
        },
        inspectFile: async (path) => {
          const info = await call(wx.getImageInfo, { src: path });
          const fs = wx.getFileSystemManager();
          const stat = await call(fs.stat.bind(fs), { path });
          return { info, bytes: stat.stats.size };
        },
        releaseFile: (path) => this.files.remove(path)
      });
      if (!this.alive) { await this.files.remove(output.path); return; }
      this.outputPath = output.path;
      this.setData({ evidence: {
        width: output.info.width, height: output.info.height, bytes: output.bytes, format: output.info.type
      }, cleanupPending: false });
    } catch (error) {
      if (this.alive) this.setData({ error: errorText(error), cleanupPending: this.files.failures.size > 0 });
    } finally { if (this.alive) this.setData({ busy: false }); }
  },
  async save() {
    if (!this.outputPath || !this.data.evidence || this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      await call(wx.saveImageToPhotosAlbum, { filePath: this.outputPath });
      if (this.alive) wx.showToast({ title: "测试照片已保存", icon: "success" });
    } catch { if (this.alive) this.setData({ error: "保存未完成，请检查相册权限后重试。" }); }
    finally { if (this.alive) this.setData({ busy: false }); }
  },
  async retryCleanup() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      if (this.pendingJobId && this.client) { await this.client.cancel(this.pendingJobId); this.pendingJobId = null; }
      await this.files.sweep();
      await this.files.cleanup([this.cutoutPath, this.outputPath]);
      if (this.alive) this.setData({ cleanupPending: false, error: "" });
    } catch { if (this.alive) this.setData({ cleanupPending: true, error: "清理或取消未完成，可稍后重试；服务器任务最长保留 10 分钟。" }); }
    finally { if (this.alive) this.setData({ busy: false }); }
  },
  openSettings() { wx.openSetting({}); },
  onUnload() {
    this.alive = false;
    this.canvasAttempt = (this.canvasAttempt || 0) + 1;
    if (this.canvasInitTimer) clearTimeout(this.canvasInitTimer);
    this.canvasInitTimer = null;
    if (this.connectingClient) this.connectingClient.abortAll();
    this.cancelProcessing();
    if (this.files) this.files.close().catch(() => {});
    this.cutoutImage = null;
    this.originalImage = null;
    this.localSourceImageData = null;
    this.localAlphaMask = null;
    this.canvas = null;
    this.uploadCanvas = null;
  }
});

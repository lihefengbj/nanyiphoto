const { reserveExportPath, releaseExportPath, isMissingFile, findAbandonedExports } = require("./export-files");
const call = (method, args) => new Promise((resolve, reject) => method({ ...args, success: resolve, fail: reject }));

class ManagedFiles {
  constructor(platform) {
    this.platform = platform;
    this.files = new Set();
    this.failures = new Set();
    this.jobs = new Map();
    this.closed = false;
  }
  reserve(format) {
    if (this.closed) throw new Error("USER_CANCELLED");
    const path = reserveExportPath(this.platform.env.USER_DATA_PATH, format);
    this.files.add(path);
    return path;
  }
  async save(tempFilePath, format) {
    const path = this.reserve(format);
    const fs = this.platform.getFileSystemManager();
    try { await call(fs.saveFile.bind(fs), { tempFilePath, filePath: path }); }
    catch {
      await this.remove(path);
      throw new Error("EXPORT_FAILED");
    }
    return path;
  }
  remove(path) {
    if (!this.files.has(path)) return Promise.resolve(true);
    if (this.jobs.has(path)) return this.jobs.get(path);
    const job = Promise.resolve().then(async () => {
      try {
        const fs = this.platform.getFileSystemManager();
        await call(fs.unlink.bind(fs), { filePath: path });
      } catch (error) {
        if (!isMissingFile(error)) {
          this.failures.add(path);
          return false;
        }
      }
      this.files.delete(path);
      this.failures.delete(path);
      releaseExportPath(path);
      return true;
    }).finally(() => { this.jobs.delete(path); });
    this.jobs.set(path, job);
    return job;
  }
  async sweep() {
    const fs = this.platform.getFileSystemManager();
    const paths = await findAbandonedExports(fs, this.platform.env.USER_DATA_PATH);
    paths.forEach((path) => this.files.add(path));
    for (const path of paths) await this.remove(path);
    if (this.failures.size) throw new Error("TEMP_CLEANUP_FAILED");
  }
  async cleanup(keep = []) {
    for (const path of Array.from(this.files)) if (!keep.includes(path)) await this.remove(path);
    if (this.failures.size) throw new Error("TEMP_CLEANUP_FAILED");
  }
  close() {
    this.closed = true;
    this.files.forEach((path) => releaseExportPath(path));
    return this.cleanup();
  }
}
module.exports = { ManagedFiles, call };

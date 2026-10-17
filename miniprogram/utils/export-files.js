const activePaths = new Set();
let sequence = 0;
const reservedName = /^nanyiphoto-export-[a-z0-9]+-[a-z0-9]{8}-\d+\.(jpg|png)$/;
const call = (method, args) => new Promise((resolve, reject) => method({ ...args, success: resolve, fail: reject }));

function reserveExportPath(root, format) {
  if (typeof root !== "string" || !root || !["jpeg", "png"].includes(format)) throw new Error("INVALID_EXPORT");
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  const name = `nanyiphoto-export-${Date.now().toString(36)}-${random}-${++sequence}.${format === "jpeg" ? "jpg" : "png"}`;
  const path = `${root}/${name}`;
  activePaths.add(path);
  return path;
}

function releaseExportPath(path) { activePaths.delete(path); }

function isMissingFile(error) {
  if (error && [1300002, 1301112].includes(error.errno)) return true;
  const message = error && typeof error.errMsg === "string" ? error.errMsg : "";
  // Only inspect the platform's fixed prefix; never persist its trailing private path.
  return /^unlink:fail (no such file or directory|no such file|file not exist)\b/i.test(message);
}

async function findAbandonedExports(fs, root) {
  if (typeof root !== "string" || !root) throw new Error("TEMP_CLEANUP_FAILED");
  const result = await call(fs.readdir.bind(fs), { dirPath: root });
  if (!result || !Array.isArray(result.files)) throw new Error("TEMP_CLEANUP_FAILED");
  return result.files.filter((name) => typeof name === "string" && reservedName.test(name))
    .map((name) => `${root}/${name}`).filter((path) => !activePaths.has(path));
}

module.exports = { reserveExportPath, releaseExportPath, isMissingFile, findAbandonedExports };

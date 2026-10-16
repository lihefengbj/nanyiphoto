function createApi(config) {
  if (!config || !["local", "cloud"].includes(config.transport)) throw new Error("INVALID_API_CONFIG");
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const header = { ...(options.header || {}) };
    if (config.transport === "local") {
      if (!config.developmentToken) return reject(new Error("LOCAL_TOKEN_NOT_CONFIGURED"));
      header.Authorization = `Bearer ${config.developmentToken}`;
    }
    const success = (response) => {
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data);
      else if (response.statusCode === 304) resolve({ notModified: true });
      else reject(new Error(response.data && response.data.error ? response.data.error.code : "API_FAILED"));
    };
    const args = {
      path, method: options.method || "GET", data: options.data, header,
      timeout: 10000, success, fail: () => reject(new Error("NETWORK_FAILED"))
    };
    if (config.transport === "cloud") {
      if (!config.cloudEnvironment || !config.cloudService) return reject(new Error("CLOUD_NOT_CONFIGURED"));
      wx.cloud.callContainer({ ...args, config: { env: config.cloudEnvironment }, header: {
        ...header, "X-WX-SERVICE": config.cloudService
      } });
    } else wx.request({ ...args, url: config.baseUrl + path });
  });
  return {
    request,
    getSpecs: (etag) => request("/api/specs", { header: etag ? { "If-None-Match": etag } : {} }),
    createUpload: () => request("/api/uploads", { method: "POST" }),
    getTask: (id) => request(`/api/tasks/${encodeURIComponent(id)}`),
    cancelTask: (id) => request(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
  };
}
module.exports = { createApi };

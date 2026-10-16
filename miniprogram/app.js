const { logger } = require("./utils/logger");
const { diagnostics } = require("./config");

App({
  diagnostics: logger,
  onLaunch() {
    logger.configure(diagnostics);
    logger.emit("app.started");
    if (typeof wx.onNeedPrivacyAuthorization === "function") {
      wx.onNeedPrivacyAuthorization((resolve) => {
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        const component = page && page.selectComponent("#privacy");
        if (component) component.requestAuthorization(resolve);
        else {
          logger.emit("privacy.unavailable", "WARNING", { errorCode: "PRIVACY_UNAVAILABLE" });
          resolve({ event: "disagree" });
        }
      });
    }
  }
});

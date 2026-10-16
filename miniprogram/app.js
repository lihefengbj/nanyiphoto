App({
  onLaunch() {
    if (typeof wx.onNeedPrivacyAuthorization === "function") {
      wx.onNeedPrivacyAuthorization((resolve) => {
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        const component = page && page.selectComponent("#privacy");
        if (component) component.requestAuthorization(resolve);
        else resolve({ event: "disagree" });
      });
    }
  }
});

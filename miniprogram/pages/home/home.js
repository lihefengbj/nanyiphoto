const presets = require("../../data/photo-presets");
Page({
  data: { presets },
  onShareAppMessage() {
    return {
      title: "南一证件照｜轻松制作日常证件照",
      path: "/pages/home/home"
    };
  },
  onShareTimeline() {
    return {
      title: "南一证件照｜简单·本地·自然"
    };
  },
  openLab(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.id || "one-inch";
    wx.navigateTo({ url: `/pages/lab/lab?preset=${encodeURIComponent(id)}` });
  }
});

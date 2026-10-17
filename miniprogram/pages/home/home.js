const presets = require("../../data/photo-presets");
Page({
  data: { presets },
  openLab(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.id || "one-inch";
    wx.navigateTo({ url: `/pages/lab/lab?preset=${encodeURIComponent(id)}` });
  }
});

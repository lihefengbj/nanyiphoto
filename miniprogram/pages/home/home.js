const catalog = require("../../data/specs");
Page({
  data: { specs: catalog.specs, version: catalog.version },
  openSpec(event) {
    wx.navigateTo({ url: `/pages/spec-detail/spec-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },
  openLab() { wx.navigateTo({ url: "/pages/lab/lab" }); },
  openMatting() { wx.navigateTo({ url: "/pages/matting/matting" }); }
});

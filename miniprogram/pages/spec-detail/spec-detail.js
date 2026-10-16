const catalog = require("../../data/specs");
Page({
  data: { spec: null },
  onLoad(query) {
    const spec = catalog.specs.find((item) => item.id === query.id);
    this.setData({ spec: spec || null });
  },
  back() { wx.navigateBack(); }
});

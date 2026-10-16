Component({
  data: { visible: false },
  methods: {
    requestAuthorization(resolve) {
      if (this.pending) this.pending({ event: "disagree" });
      this.pending = resolve;
      this.setData({ visible: true });
    },
    openAgreement() {
      wx.openPrivacyContract({ fail: () => wx.showToast({ title: "请先在后台配置隐私协议", icon: "none" }) });
    },
    agree() {
      if (this.pending) this.pending({ event: "agree", buttonId: "privacy-agree" });
      this.pending = null;
      this.setData({ visible: false });
    },
    disagree() {
      if (this.pending) this.pending({ event: "disagree" });
      this.pending = null;
      this.setData({ visible: false });
    }
  },
  lifetimes: {
    detached() {
      if (this.pending) this.pending({ event: "disagree" });
      this.pending = null;
    }
  }
});

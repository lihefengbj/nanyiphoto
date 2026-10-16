const { logger } = require("../../utils/logger");

Component({
  data: { visible: false },
  methods: {
    requestAuthorization(resolve) {
      if (this.pending) this.pending({ event: "disagree" });
      this.pending = resolve;
      this.setData({ visible: true });
    },
    openAgreement() {
      wx.openPrivacyContract({ fail: () => {
        logger.emit("privacy.contract_failed", "WARNING", { errorCode: "PRIVACY_UNAVAILABLE" });
        wx.showToast({ title: "请先在后台配置隐私协议", icon: "none" });
      } });
    },
    agree() {
      logger.emit("privacy.agreed");
      if (this.pending) this.pending({ event: "agree", buttonId: "privacy-agree" });
      this.pending = null;
      this.setData({ visible: false });
    },
    disagree() {
      logger.emit("privacy.declined", "INFO");
      if (this.pending) this.pending({ event: "disagree" });
      this.pending = null;
      this.setData({ visible: false });
    }
  },
  lifetimes: {
    detached() {
      if (this.pending) {
        logger.emit("privacy.declined", "INFO");
        this.pending({ event: "disagree" });
      }
      this.pending = null;
    }
  }
});

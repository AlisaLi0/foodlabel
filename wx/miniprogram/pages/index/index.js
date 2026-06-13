const api = require('../../utils/api.js');

const STEP_LABELS = ['识别图片', '识读内容', '判定适用规则', '合规评价', '生成报告'];

Page({
  data: {
    tempFilePath: '',
    credits: null,
    submitting: false,
    step: 0,
    stepLabels: STEP_LABELS,
    statusText: '',
    canSubmit: false,
    showPrivacy: false,
    privacyContractName: '',
  },

  onLoad() {
    // 官方隐私方案（基础库 2.32.3+）：监听到隐私接口（如 chooseMedia）被调用且用户未同意时，
    // 弹出自定义授权弹窗；用户点「同意」后 resolve 放行，接口继续执行。低版本无此 API 时跳过。
    if (typeof wx.onNeedPrivacyAuthorization === 'function') {
      wx.onNeedPrivacyAuthorization((resolve) => {
        this._privacyResolve = resolve;
        this.setData({ showPrivacy: true });
      });
    }
    if (typeof wx.getPrivacySetting === 'function') {
      wx.getPrivacySetting({
        success: (res) => {
          if (res && res.privacyContractName) {
            this.setData({ privacyContractName: res.privacyContractName });
          }
        },
      });
    }
  },

  onShow() {
    this._refreshMe();
  },

  _refreshMe() {
    api.fetchMe().then((me) => {
      this.setData({ credits: me.credits });
    }).catch(() => { /* onLaunch 已处理登录 */ });
  },

  _recompute() {
    const can = !!this.data.tempFilePath && !this.data.submitting;
    if (can !== this.data.canSubmit) this.setData({ canSubmit: can });
  },

  // 打开后台配置的《用户隐私保护指引》
  onOpenPrivacyContract() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({ fail: () => wx.showToast({ title: '打开失败', icon: 'none' }) });
    }
  },

  // 用户点「同意」：告知平台已同意，被拦截的隐私接口（chooseMedia）会自动继续执行
  onAgreePrivacy() {
    this.setData({ showPrivacy: false });
    if (this._privacyResolve) {
      this._privacyResolve({ event: 'agree' });
      this._privacyResolve = null;
    }
  },

  // 用户点「不同意」：关闭弹窗并告知平台拒绝，本次选图取消
  onDisagreePrivacy() {
    this.setData({ showPrivacy: false });
    if (this._privacyResolve) {
      this._privacyResolve({ event: 'disagree' });
      this._privacyResolve = null;
    }
  },

  onChooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (f.size > 8 * 1024 * 1024) {
          wx.showToast({ title: '图片过大（>8MB）', icon: 'none' });
          return;
        }
        this.setData({ tempFilePath: f.tempFilePath, statusText: '' });
        this._recompute();
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') !== -1) return; // 用户主动取消，不提示
        wx.showToast({ title: '打开相册失败，请重试', icon: 'none', duration: 2000 });
      },
    });
  },

  onRemoveImage() {
    this.setData({ tempFilePath: '' });
    this._recompute();
  },

  onSubmit() {
    if (!this.data.canSubmit) return;
    this.setData({ submitting: true, step: 0, statusText: '上传中…', canSubmit: false });
    api.startCheck(this.data.tempFilePath).then((res) => {
      this.setData({ credits: res.credits, statusText: '正在检查（约 30 秒）…' });
      this._poll(res.job_id, 0);
    }).catch((err) => {
      this.setData({ submitting: false, statusText: '' });
      this._recompute();
      if (err.code === 402) {
        wx.showModal({
          title: '次数不足',
          content: err.message || '今日免费次数已用完，可分享小程序获取更多。',
          confirmText: '去分享', cancelText: '知道了',
          success: (r) => { if (r.confirm) wx.switchTab({ url: '/pages/me/me' }); },
        });
      } else {
        wx.showToast({ title: err.message || '检查失败', icon: 'none' });
      }
    });
  },

  // 轮询任务进度；完成后跳结果页
  _poll(jobId, tries) {
    if (tries > 120) { // 约 4 分钟兜底
      this.setData({ submitting: false, statusText: '检查超时，请重试' });
      this._recompute();
      return;
    }
    api.pollResult(jobId).then((r) => {
      if (r.error) {
        this.setData({ submitting: false, statusText: '' });
        this._recompute();
        wx.showToast({ title: r.error, icon: 'none', duration: 3000 });
        return;
      }
      if (r.step && r.step !== this.data.step) {
        this.setData({ step: r.step });
      }
      if (r.done && r.result) {
        // 把结果暂存全局，结果页读取，避免超长 URL
        getApp().globalData.lastResult = r.result;
        getApp().globalData.lastImage = this.data.tempFilePath; // 本次上传的原图，结果页顶部展示
        this.setData({ submitting: false, statusText: '' });
        this._recompute();
        this._refreshMe();
        wx.navigateTo({ url: '/pages/result/result' });
        return;
      }
      setTimeout(() => this._poll(jobId, tries + 1), 2000);
    }).catch((err) => {
      // 轮询偶发失败，继续重试
      if (tries > 120) {
        this.setData({ submitting: false, statusText: '网络异常，请重试' });
        this._recompute();
        return;
      }
      setTimeout(() => this._poll(jobId, tries + 1), 2500);
    });
  },

  onShareAppMessage() {
    return {
      title: '食品标签合规检查 — 拍照对照国标，秒查问题',
      path: '/pages/index/index',
    };
  },
});

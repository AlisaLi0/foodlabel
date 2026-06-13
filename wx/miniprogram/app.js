// app.js — 启动时静默登录、持有会话 token
const { wxLogin } = require('./utils/api.js');

App({
  globalData: {
    token: '',
    credits: null,
    // 后端：复用 docs-tools.online 的 foodlabel 后端（子路径）
    apiBase: 'https://docs-tools.online/foodlabel',
  },

  onLaunch() {
    const cached = wx.getStorageSync('token');
    if (cached) this.globalData.token = cached;
    this.ensureLogin();
  },

  // 返回 Promise<token>。force=true 强制重新登录。
  ensureLogin(force) {
    return new Promise((resolve, reject) => {
      if (this.globalData.token && !force) return resolve(this.globalData.token);
      wx.login({
        success: (res) => {
          if (!res.code) return reject(new Error('wx.login 未返回 code'));
          wxLogin(res.code).then((data) => {
            this.globalData.token = data.token;
            this.globalData.credits = data.credits;
            wx.setStorageSync('token', data.token);
            resolve(data.token);
          }).catch(reject);
        },
        fail: reject,
      });
    });
  },
});

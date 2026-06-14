const api = require('../../utils/api.js');

Page({
  data: {
    credits: null,
    shareClaimedToday: false,
    shareReward: 0,
    openidShort: '',
  },

  onShow() {
    this._refresh();
  },

  _refresh() {
    api.fetchMe().then((me) => {
      this.setData({
        credits: me.credits,
        shareClaimedToday: me.share_claimed_today,
        shareReward: me.share_reward_amount,
      });
    }).catch(() => {});
  },

  onShareAppMessage() {
    // 微信 onShareAppMessage 返回对象不支持 success 回调（早已移除分享成功检测）。
    // 改为在用户触发分享时即发奖，靠后端「每日一次」(share_date)封顶防刷。
    if (!this.data.shareClaimedToday) {
      api.claimShareReward().then((r) => {
        this.setData({ credits: r.credits, shareClaimedToday: true });
        wx.showToast({ title: `+${r.share_reward_amount} 次`, icon: 'success' });
      }).catch(() => { /* 今日已领或网络异常：静默 */ });
    }
    return {
      title: '食品标签合规检查 — 拍照对照国标，秒查问题',
      path: '/pages/index/index',
    };
  },

  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  onOpenStandards() {
    wx.navigateTo({ url: '/pages/standards/standards' });
  },

  onOpenHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },
});

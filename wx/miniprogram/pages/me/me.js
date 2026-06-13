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
    // 分享成功后领奖励（每日一次）
    return {
      title: '食品标签合规检查 — 拍照对照国标，秒查问题',
      path: '/pages/index/index',
      success: () => {
        if (this.data.shareClaimedToday) return;
        api.claimShareReward().then((r) => {
          this.setData({ credits: r.credits, shareClaimedToday: true });
          wx.showToast({ title: `+${r.share_reward_amount} 次`, icon: 'success' });
        }).catch(() => {});
      },
    };
  },

  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  onOpenHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },
});

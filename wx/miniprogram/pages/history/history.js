const api = require('../../utils/api.js');

const VERDICT_TEXT = {
  compliant: '未见问题',
  issues: '需复核',
  non_compliant: '不符合',
  not_a_label: '非标签',
};

Page({
  data: {
    items: [],
    loading: true,
  },

  onShow() {
    this._load();
  },

  _load() {
    this.setData({ loading: true });
    api.fetchHistory().then((res) => {
      const items = (res.items || []).map((x) => ({
        id: x.id,
        thumb: x.thumb || '',
        food_name: x.food_name || '未识读到名称',
        verdict: x.verdict,
        verdictText: VERDICT_TEXT[x.verdict] || '已检查',
        score: x.score,
        timeText: this._fmtTime(x.ts),
      }));
      this.setData({ items, loading: false });
    }).catch(() => {
      this.setData({ loading: false });
    });
  },

  _fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/result/result?hid=' + id });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除记录',
      content: '确定删除这条识别历史？图片和结果将从服务器移除，不可恢复。',
      confirmText: '删除',
      confirmColor: '#c2362f',
      success: (r) => {
        if (!r.confirm) return;
        api.deleteHistory(id).then(() => {
          this.setData({ items: this.data.items.filter((x) => x.id !== id) });
          wx.showToast({ title: '已删除', icon: 'success' });
        }).catch(() => {
          wx.showToast({ title: '删除失败', icon: 'none' });
        });
      },
    });
  },
});

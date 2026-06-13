// 法规原文页：链接指向本工具网页版，「查看 PDF」下载并用原生阅读器打开我们的官方 PDF。
const api = require('../../utils/api.js');

// 本工具网页版法规页（带锚点定位到对应文档）
const WEB_BASE = api.API_BASE + '/standards.html';

const DOCS = [
  {
    id: 'gb7718',
    title: 'GB 7718-2025 预包装食品标签通则',
    sub: '2025-03-16 发布 · 2027-03-16 实施 · 卫健委、市场监管总局（代替 GB 7718-2011）',
    webUrl: WEB_BASE + '#gb7718',
    pdf: 'docs/gb7718-2025.pdf',
  },
  {
    id: 'gb28050',
    title: 'GB 28050-2025 预包装食品营养标签通则',
    sub: '2025-03-16 发布 · 2027-03-16 实施 · 卫健委、市场监管总局（代替 GB 28050-2011）',
    webUrl: WEB_BASE + '#gb28050',
    pdf: 'docs/gb28050-2025.pdf',
  },
  {
    id: 'decree100',
    title: '食品标识监督管理办法（总局令第100号）',
    sub: '2025-03-14 公布 · 2027-03-16 施行 · 国家市场监督管理总局（7章54条）',
    webUrl: WEB_BASE + '#decree100',
    pdf: 'docs/decree-100.pdf',
  },
];

Page({
  data: {
    docs: DOCS.map((d) => ({
      id: d.id, title: d.title, sub: d.sub, webUrl: d.webUrl, loading: false,
    })),
  },

  // 复制本工具网页版链接到剪贴板（小程序内不能直接打开外部网页）
  onCopyWeb(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '网页链接已复制，可在浏览器打开', icon: 'none' }),
    });
  },

  // 查看 PDF：下载我们的官方 PDF 后用微信原生文档阅读器打开
  onOpenPdf(e) {
    const id = e.currentTarget.dataset.id;
    const idx = this.data.docs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const meta = DOCS[idx];
    if (this.data.docs[idx].loading) return;
    this.setData({ [`docs[${idx}].loading`]: true });
    wx.showLoading({ title: '加载中…' });
    wx.downloadFile({
      url: api.API_BASE + '/' + meta.pdf,
      timeout: 30000,
      success: (res) => {
        if (res.statusCode === 200 && res.tempFilePath) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'pdf',
            showMenu: true,
            fail: () => wx.showToast({ title: '无法打开 PDF', icon: 'none' }),
          });
        } else {
          wx.showToast({ title: '下载失败（' + res.statusCode + '）', icon: 'none' });
        }
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        wx.showToast({ title: msg.indexOf('domain') >= 0 ? '需在后台配置下载域名' : '下载失败', icon: 'none' });
      },
      complete: () => {
        wx.hideLoading();
        this.setData({ [`docs[${idx}].loading`]: false });
      },
    });
  },
});


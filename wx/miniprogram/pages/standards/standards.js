// 法规原文页：列出依据法规 + 官方来源链接（点按复制）+ 展开全文（懒加载静态文档）
const api = require('../../utils/api.js');

const DOCS = [
  {
    id: 'gb7718',
    title: 'GB 7718-2025 预包装食品标签通则',
    sub: '2025-03-16 发布 · 2027-03-16 实施 · 卫健委、市场监管总局（代替 GB 7718-2011）',
    links: [
      { label: '官方发布公告：卫健委 2025年第2号', url: 'https://www.nhc.gov.cn/sps/c100088/202503/e8a432507f7d4f08a877e76a9b0578ce.shtml' },
      { label: '官方问答：GB 7718-2025（2025-09-25）', url: 'https://www.nhc.gov.cn/sps/c100087/202509/bc824a504ec34c27883da73f14c20d44.shtml' },
    ],
    docFile: 'docs/gb7718-2025.txt',
    fmt: 'txt',
  },
  {
    id: 'gb28050',
    title: 'GB 28050-2025 预包装食品营养标签通则',
    sub: '2025-03-16 发布 · 2027-03-16 实施 · 卫健委、市场监管总局（代替 GB 28050-2011）',
    links: [
      { label: '官方发布公告：卫健委 2025年第2号', url: 'https://www.nhc.gov.cn/sps/c100088/202503/e8a432507f7d4f08a877e76a9b0578ce.shtml' },
      { label: '官方问答：GB 28050-2025（2025-09-25）', url: 'https://www.nhc.gov.cn/sps/c100087/202509/470fa4ff5de14dd38619223cce9da4e7.shtml' },
    ],
    docFile: 'docs/gb28050-2025.txt',
    fmt: 'txt',
  },
  {
    id: 'decree100',
    title: '食品标识监督管理办法（总局令第100号）',
    sub: '2025-03-14 公布 · 2027-03-16 施行 · 国家市场监督管理总局（7章54条）',
    links: [
      { label: '官方来源：司法部 部门规章库', url: 'https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202511/t20251106_527628.html' },
    ],
    docFile: 'docs/decree-100.md',
    fmt: 'md',
  },
];

// 纯文本：把“N 标题”形式的章标题提为小标题，其余为正文段。
function renderTxt(text) {
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (/^\d{1,2}\s+[\u4e00-\u9fff]/.test(t) && t.length <= 24) {
      return { type: 'h', text: t };
    }
    return { type: 'p', text: line };
  });
}

// 轻量 Markdown：## 小标题、**加粗**段、> 引用，其余正文。
function renderMd(text) {
  return text.split('\n').map((line) => {
    if (/^#\s+/.test(line)) return null; // 顶层标题已在卡片头展示
    if (/^##\s+/.test(line)) return { type: 'h', text: line.replace(/^##\s+/, '') };
    if (/^>\s?/.test(line)) return { type: 'q', text: line.replace(/^>\s?/, '') };
    return { type: 'p', text: line.replace(/\*\*(.+?)\*\*/g, '$1') };
  }).filter((x) => x !== null);
}

Page({
  data: {
    docs: DOCS.map((d) => ({
      id: d.id, title: d.title, sub: d.sub, links: d.links,
      open: false, loading: false, error: '', lines: [],
    })),
  },

  // 点按官方链接：复制到剪贴板（小程序内不能直接打开外部网页）
  onCopyLink(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制，可在浏览器打开', icon: 'none' }),
    });
  },

  // 展开/收起全文；首次展开时懒加载文档文本
  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const idx = this.data.docs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const doc = this.data.docs[idx];
    const willOpen = !doc.open;
    this.setData({ [`docs[${idx}].open`]: willOpen });
    if (willOpen && !doc.lines.length && !doc.loading) {
      this._load(idx);
    }
  },

  _load(idx) {
    const meta = DOCS[idx];
    this.setData({ [`docs[${idx}].loading`]: true, [`docs[${idx}].error`]: '' });
    wx.request({
      url: api.API_BASE + '/' + meta.docFile,
      method: 'GET',
      dataType: 'text',
      timeout: 20000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && typeof res.data === 'string') {
          const raw = meta.fmt === 'md' ? renderMd(res.data) : renderTxt(res.data);
          const lines = raw.map((ln, i) => ({ i, type: ln.type, text: ln.text }));
          this.setData({ [`docs[${idx}].lines`]: lines, [`docs[${idx}].loading`]: false });
        } else {
          this.setData({ [`docs[${idx}].loading`]: false, [`docs[${idx}].error`]: '加载失败（HTTP ' + res.statusCode + '）' });
        }
      },
      fail: (err) => {
        this.setData({ [`docs[${idx}].loading`]: false, [`docs[${idx}].error`]: err.errMsg || '网络错误' });
      },
    });
  },
});

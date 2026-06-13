const VERDICT = {
  compliant: { text: '未检测出明显问题', cls: 'ok' },
  issues: { text: '标签存在需复核或不规范之处', cls: 'warn' },
  non_compliant: { text: '标签存在不符合国家标准的问题', cls: 'fail' },
  not_a_label: { text: '未能识别为食品标签', cls: 'warn' },
};
const STATUS_LABEL = { pass: '未见问题', miss: '缺失', fail: '不符合', warn: '需复核', na: '不适用', unknown: '看不清', pending: '待评价' };
const FIELD_LABEL = {
  food_name: '食品名称', ingredients: '配料表', additives: '食品添加剂',
  net_content: '净含量', barcode: '条码', spec: '规格', producer: '生产者/经营者', address: '地址',
  contact: '联系方式', production_date: '生产日期', shelf_life: '保质期',
  expiry_date: '保质期到期日', storage: '贮存条件', license_no: '生产许可证编号',
  standard_code: '产品标准代号', quality_grade: '质量等级', allergens: '致敏物质',
  claims: '声称/强调', nutrition_warning: '盐油糖提示语', other_text: '其他文字',
};
const FIELD_ORDER = [
  'food_name', 'ingredients', 'additives', 'net_content', 'barcode', 'spec', 'producer',
  'address', 'contact', 'production_date', 'shelf_life', 'expiry_date', 'storage',
  'license_no', 'standard_code', 'quality_grade', 'allergens', 'claims',
  'nutrition_warning', 'other_text',
];

const api = require('../../utils/api.js');

Page({
  data: {
    verdict: null,
    score: null,
    counts: '',
    catName: '',
    previewImage: '',
    fingerprint: null,
    fields: [],
    nutrition: [],
    rows: [],
    missing: [],
    problems: [],
    risks: [],
  },

  onLoad(options) {
    // 来自历史：带 hid → 从服务器拉取该条历史的完整结果渲染。
    if (options && options.hid) {
      wx.showLoading({ title: '加载中…' });
      api.fetchHistoryDetail(options.hid).then((d) => {
        wx.hideLoading();
        if (d && d.result) {
          const img = (d.images && d.images[0]) || '';
          if (img) this.setData({ previewImage: img });
          this._render(d.result);
        } else {
          wx.showToast({ title: '历史不存在', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 1200);
        }
      }).catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '加载失败', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1200);
      });
      return;
    }
    const r = (getApp().globalData && getApp().globalData.lastResult) || null;
    if (!r) {
      wx.showToast({ title: '结果已失效，请重新检查', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }
    const localImg = (getApp().globalData && getApp().globalData.lastImage) || '';
    if (localImg) this.setData({ previewImage: localImg });
    this._render(r);
  },

  _render(r) {
    const sm = r.summary || {};
    const v = VERDICT[sm.verdict] || VERDICT.issues;
    const counts = `未见问题 ${sm.pass || 0} · 缺失 ${sm.miss || 0} · 不符合 ${sm.fail || 0} · 需复核 ${sm.warn || 0}`;

    const ex = r.extracted || {};
    const fields = FIELD_ORDER
      .filter((k) => ex[k] && (typeof ex[k] === 'string' ? ex[k].trim() : true) && k !== 'other_text')
      .map((k) => ({ k, label: FIELD_LABEL[k] || k, val: ex[k] }));
    const nutrition = Array.isArray(ex.nutrition_table) ? ex.nutrition_table : [];

    // 产品指纹：让不同产品的报告一眼可区分
    const fpName = (typeof ex.food_name === 'string' ? ex.food_name.trim() : '') || '未识读到名称';
    const fpMeta = [];
    const fpNc = typeof ex.net_content === 'string' ? ex.net_content.trim() : '';
    if (fpNc) fpMeta.push(fpNc);
    const fpBc = typeof ex.barcode === 'string' ? ex.barcode.trim() : '';
    if (fpBc) fpMeta.push('条码 ' + fpBc);
    const fingerprint = { name: fpName, meta: fpMeta.join('　·　') };

    // 合并 适用规则 + 检查结果
    const rules = r.rules || {};
    const applicable = Array.isArray(rules.applicable) ? rules.applicable : [];
    const checkById = {};
    (Array.isArray(r.checks) ? r.checks : []).forEach((c) => { if (c && c.id) checkById[c.id] = c; });
    const rows = applicable.map((a) => {
      const c = checkById[a.id];
      let resCls = 'pending', resTxt = STATUS_LABEL.pending, note = '';
      if (!a.applicable) {
        resCls = 'na'; resTxt = STATUS_LABEL.na; note = a.reason || '';
      } else if (c) {
        const st = (c.status || 'unknown').toLowerCase();
        resCls = st; resTxt = STATUS_LABEL[st] || st;
        note = st === 'pass' ? '' : (c.finding || '');
      }
      return {
        id: a.id, item: a.item, basis: (c && c.basis) || a.basis || '',
        appCls: a.applicable ? 'pass' : 'na', appTxt: a.applicable ? '适用' : '豁免',
        resCls, resTxt, note,
        rowCls: (resCls === 'fail' || resCls === 'miss') ? 'row-fail' : (resCls === 'warn' ? 'row-warn' : ''),
      };
    });

    wx.setNavigationBarTitle({ title: v.text });
    this.setData({
      verdict: v,
      score: typeof sm.score === 'number' ? sm.score : null,
      counts,
      catName: rules.category_name || '',
      fields, nutrition, rows,
      fingerprint,
      missing: r.missing || [],
      problems: r.problems || [],
      risks: r.risks || [],
    });
  },

  onBack() { wx.navigateBack(); },

  onPreviewImage() {
    if (this.data.previewImage) {
      wx.previewImage({ urls: [this.data.previewImage], current: this.data.previewImage });
    }
  },

  onShareAppMessage() {
    return { title: '我用食品标签合规检查查了一份标签', path: '/pages/index/index' };
  },
});

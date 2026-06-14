const api = require('../../utils/api.js');

const STEP_LABELS = ['识别图片', '识读内容', '判定适用规则', '合规评价', '生成报告'];

// 进行中的检查任务持久化：起检查后存 job_id+图片路径，刷新/重启后可恢复「正在处理」状态。
const ACTIVE_JOB_KEY = 'foodlabel_active_job';
const ACTIVE_JOB_TTL = 10 * 60 * 1000; // 10 分钟内的任务才恢复
function saveActiveJob(jobId, paths) {
  try { wx.setStorageSync(ACTIVE_JOB_KEY, { job_id: jobId, paths: paths || [], ts: Date.now() }); } catch (e) { /* ignore */ }
}
function loadActiveJob() {
  try {
    const j = wx.getStorageSync(ACTIVE_JOB_KEY);
    if (j && j.job_id && (Date.now() - (j.ts || 0) < ACTIVE_JOB_TTL)) return j;
  } catch (e) { /* ignore */ }
  return null;
}
function clearActiveJob() {
  try { wx.removeStorageSync(ACTIVE_JOB_KEY); } catch (e) { /* ignore */ }
}

Page({
  data: {
    tempFilePaths: [],
    credits: null,
    submitting: false,
    step: 0,
    stepLabels: STEP_LABELS,
    statusText: '',
    canSubmit: false,
    showPrivacy: false,
    privacyContractName: '',
    history: [],
  },

  onLoad() {
    // 平台检测：纯血鸿蒙(platform=ohos)上 wx.chooseMedia 存在裸 fail 兼容问题，
    // 走旧版 wx.chooseImage；其它平台用功能更全的 chooseMedia。
    try {
      const info = (typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : wx.getSystemInfoSync()) || {};
      const platform = String(info.platform || '').toLowerCase();
      this._isHarmony = platform === 'ohos' || platform.indexOf('harmony') !== -1;
    } catch (e) {
      this._isHarmony = false;
    }
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
    this._resumeJob();
    this._loadHistory();
  },

  // 拉取识别历史（处理成功/处理失败）；「处理中」由 submitting 状态在顶部展示。
  _loadHistory() {
    api.fetchHistory().then((res) => {
      const items = (res.items || []).map((x) => {
        const failed = x.verdict === 'failed';
        return {
          id: x.id,
          thumb: x.thumb || '',
          name: failed ? '识别失败' : (x.food_name || '未识读到名称'),
          state: failed ? 'failed' : 'success',
          stateText: failed ? '处理失败' : '处理成功',
          timeText: this._fmtTime(x.ts),
        };
      });
      this.setData({ history: items });
    }).catch(() => { /* 未登录/网络异常：留空 */ });
  },

  _fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // 点历史条目：成功→开结果页；失败→提示重传重试（未扣次数）
  onOpenHistory(e) {
    const id = e.currentTarget.dataset.id;
    const state = e.currentTarget.dataset.state;
    if (!id) return;
    if (state === 'failed') {
      wx.showModal({
        title: '该次识别失败',
        content: '这次检查未成功（未扣次数）。可在上方重新上传重试。',
        showCancel: false, confirmText: '知道了',
      });
      return;
    }
    wx.navigateTo({ url: '/pages/result/result?hid=' + id });
  },

  // 点「处理中」条目：提示稍候
  onTapProcessing() {
    wx.showToast({ title: '正在检查，请稍候', icon: 'none' });
  },

  // 刷新/重启/返回首页时，若有未完成的检查任务则恢复「正在处理」状态并续轮询。
  _resumeJob() {
    if (this.data.submitting) return; // 已在轮询，不重复
    const job = loadActiveJob();
    if (!job) return;
    this._activePaths = (job.paths || []).slice(0, 3);
    this.setData({
      submitting: true, step: 0, canSubmit: false,
      statusText: '正在检查（继续上次未完成的任务）…',
      tempFilePaths: this._activePaths,
    });
    this._poll(job.job_id, 0);
  },

  _refreshMe() {
    api.fetchMe().then((me) => {
      this.setData({ credits: me.credits });
    }).catch(() => { /* onLaunch 已处理登录 */ });
  },

  _recompute() {
    const can = this.data.tempFilePaths.length > 0 && !this.data.submitting;
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
    const remain = 3 - this.data.tempFilePaths.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多 3 张', icon: 'none' });
      return;
    }
    // 把 [{path,size}] 过滤超大图后并入已选列表（最多 3 张）
    const merge = (items) => {
      const kept = [];
      let skipped = false;
      items.forEach((it) => {
        if (it.size && it.size > 8 * 1024 * 1024) { skipped = true; return; }
        kept.push(it.path);
      });
      if (skipped) wx.showToast({ title: '已跳过过大图片（>8MB）', icon: 'none' });
      if (!kept.length) return;
      const list = this.data.tempFilePaths.concat(kept).slice(0, 3);
      this.setData({ tempFilePaths: list, statusText: '' });
      this._recompute();
    };
    // 实测：已有图后再加时，首次调用常裸 fail，重试一次就成功（原生选择面板
    // 未及时就绪）。所以 fail 后自动重试一次，用户无感知；重试仍败才提示。
    const pick = (isRetry) => {
      wx.chooseImage({
        count: remain,
        sizeType: ['compressed', 'original'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const paths = res.tempFilePaths || [];
          const files = res.tempFiles || [];
          merge(paths.map((p, i) => ({ path: p, size: files[i] && files[i].size })));
        },
        fail: (err) => {
          const msg = (err && err.errMsg) || '';
          if (msg.indexOf('cancel') !== -1) return; // 用户主动取消，不提示
          if (!isRetry) { setTimeout(() => pick(true), 350); return; } // 首次裸 fail，自动重试
          wx.showToast({ title: '打开相册失败，请重试', icon: 'none', duration: 2000 });
        },
      });
    };
    pick(false);
  },

  onRemoveImage(e) {
    const idx = e.currentTarget.dataset.idx;
    const paths = this.data.tempFilePaths.slice();
    paths.splice(idx, 1);
    this.setData({ tempFilePaths: paths });
    this._recompute();
  },

  onSubmit() {
    if (!this.data.canSubmit) return;
    const paths = this.data.tempFilePaths.slice(0, 3);
    this._activePaths = paths;
    this.setData({ submitting: true, step: 0, statusText: '上传中…', canSubmit: false });
    api.startCheck(paths).then((res) => {
      // 持久化任务：刷新/重启后可恢复。直到成功入库或返回失败才清除。
      saveActiveJob(res.job_id, paths);
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

  // 失败收尾：不扣费（后端已记失败历史），**保留图片**让用户直接重试。
  _failRetry(msg) {
    clearActiveJob();
    const cur = this.data.tempFilePaths.length ? this.data.tempFilePaths : (this._activePaths || []);
    this.setData({
      submitting: false, step: 0,
      statusText: msg || '检查失败，可重试',
      tempFilePaths: cur.slice(0, 3),
    });
    this._recompute();
    this._refreshMe();
    this._loadHistory(); // 刷出刚记录的失败条目
  },

  // 轮询任务进度；完成后跳结果页，失败则保留图片可重试
  _poll(jobId, tries) {
    if (tries > 120) { // 约 4 分钟；不清除持久化任务，下次进页可继续恢复
      this.setData({ submitting: false, statusText: '检查较慢，可稍后重新进入查看结果' });
      return;
    }
    api.pollResult(jobId).then((r) => {
      if (r.error) {
        // 后端明确失败：已记失败历史、未扣费；保留图片可重试
        this._failRetry(r.error);
        wx.showToast({ title: r.error, icon: 'none', duration: 3000 });
        return;
      }
      if (r.step && r.step !== this.data.step) {
        this.setData({ step: r.step });
      }
      if (r.done && r.result) {
        // 成功：结果已入库。清除持久化任务，跳结果页。
        clearActiveJob();
        getApp().globalData.lastResult = r.result;
        const usedImgs = (this.data.tempFilePaths.length ? this.data.tempFilePaths : (this._activePaths || [])).slice(0, 3);
        getApp().globalData.lastImages = usedImgs; // 本次上传的全部原图，结果页顶部展示
        getApp().globalData.lastImage = usedImgs[0] || ''; // 兼容旧字段
        // 检查完成即清空已用图：返回首页是空白选图态，「再查一张」需重新上传
        this.setData({ submitting: false, statusText: '', step: 0, tempFilePaths: [] });
        this._activePaths = [];
        this._recompute();
        if (typeof r.credits === 'number') this.setData({ credits: r.credits }); else this._refreshMe();
        wx.navigateTo({ url: '/pages/result/result' });
        return;
      }
      setTimeout(() => this._poll(jobId, tries + 1), 2000);
    }).catch((err) => {
      // 任务不存在/已过期（服务重启等）：当失败处理，保留图片可重试
      if (err && err.code === 404) {
        this._failRetry('处理已中断，请重试');
        return;
      }
      // 轮询偶发网络错误：继续重试
      if (tries > 120) {
        this.setData({ submitting: false, statusText: '网络异常，可稍后重新进入查看' });
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

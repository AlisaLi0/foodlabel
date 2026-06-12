// utils/api.js — 封装对 foodlabel 后端的 wx.request / wx.uploadFile
const API_BASE = 'https://docs-tools.online/biaoqianshibie';

function getToken() {
  const app = getApp();
  return (app && app.globalData && app.globalData.token) || wx.getStorageSync('token') || '';
}

function request(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.header || {});
  const tok = getToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + path,
      method: opts.method || 'GET',
      data: opts.data,
      header: headers,
      timeout: opts.timeout || 30000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 401) {
          wx.removeStorageSync('token');
          const app = getApp();
          if (app && app.globalData) app.globalData.token = '';
          reject({ code: 401, message: '登录已过期，请重试' });
        } else {
          reject({
            code: res.statusCode,
            message: (res.data && (res.data.error || res.data.detail || res.data.message)) || ('HTTP ' + res.statusCode),
          });
        }
      },
      fail: (err) => reject({ code: -1, message: err.errMsg || '网络错误' }),
    });
  });
}

function wxLogin(code) {
  return request('/api/wx/login', { method: 'POST', data: { code } });
}
function fetchMe() { return request('/api/wx/me'); }
function claimShareReward() { return request('/api/wx/share-reward', { method: 'POST' }); }

// 上传图片起检查任务，返回 { job_id, credits }
function startCheck(tempFilePaths) {
  const tok = getToken();
  const paths = Array.isArray(tempFilePaths) ? tempFilePaths : [tempFilePaths];
  // wx.uploadFile 一次只能传一个文件字段；多图时分多次不便，这里用第一张主图。
  // 食品标签通常一张即可；如需多图，后端 images 支持多份，可改造为分片合并。
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: API_BASE + '/api/wx/check',
      filePath: paths[0],
      name: 'images',
      header: { Authorization: 'Bearer ' + tok },
      timeout: 60000,
      success: (res) => {
        let payload;
        try { payload = JSON.parse(res.data); } catch (e) { return reject({ code: -3, message: '响应解析失败' }); }
        if (res.statusCode === 200) return resolve(payload);
        if (res.statusCode === 401) {
          wx.removeStorageSync('token');
          const app = getApp(); if (app && app.globalData) app.globalData.token = '';
        }
        reject({ code: res.statusCode, message: payload.error || ('HTTP ' + res.statusCode), credits: payload.credits });
      },
      fail: (err) => reject({ code: -1, message: err.errMsg || '上传失败' }),
    });
  });
}

// 轮询任务结果
function pollResult(jobId) {
  return request('/api/wx/result?job_id=' + encodeURIComponent(jobId), { timeout: 20000 });
}

module.exports = {
  API_BASE,
  request,
  wxLogin,
  fetchMe,
  claimShareReward,
  startCheck,
  pollResult,
};

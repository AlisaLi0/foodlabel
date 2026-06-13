/* 标签识别 前端逻辑：选图/拖拽/粘贴 → POST /api/check → 渲染合规报告 */
"use strict";

// 后端 API base。前后端分离：前端可单独部署，指向任意后端。解析顺序：
//   1. window.FOODLABEL_API_BASE（index.html 内联设置）
//   2. <meta name="foodlabel-api-base" content="https://...">
//   3. ""（同源，相对 <base href> 解析为 /foodlabel/api/*）
const API_BASE = (
  (typeof window !== "undefined" && window.FOODLABEL_API_BASE) ||
  document.querySelector('meta[name="foodlabel-api-base"]')?.content ||
  ""
).replace(/\/$/, "");
const api = (path) =>
  API_BASE ? `${API_BASE}/${path.replace(/^\//, "")}` : path;

const $ = (id) => document.getElementById(id);
const fileInput = $("file");
const thumbs = $("thumbs");
const runBtn = $("run");
const resetBtn = $("reset");
const statusEl = $("status");
const reportEl = $("report");

let files = []; // {file, url}

const STATUS_LABEL = {
  pass: "符合", miss: "缺失", fail: "不符合", warn: "需复核", na: "不适用", unknown: "看不清",
};
const VERDICT_LABEL = {
  compliant: "标签基本符合国家标准要求",
  issues: "标签存在需复核或不规范之处",
  non_compliant: "标签存在不符合国家标准的问题",
  not_a_label: "未能识别为食品标签",
};
const FIELD_LABEL = {
  food_name: "食品名称", ingredients: "配料表", additives: "食品添加剂",
  net_content: "净含量", barcode: "条码", spec: "规格", producer: "生产者/经营者",
  address: "地址", contact: "联系方式", production_date: "生产日期",
  shelf_life: "保质期", expiry_date: "保质期到期日", storage: "贮存条件",
  license_no: "生产许可证编号", standard_code: "产品标准代号",
  quality_grade: "质量等级", allergens: "致敏物质", claims: "声称/强调",
  nutrition_warning: "盐油糖提示语", other_text: "其他文字",
};
const FIELD_ORDER = [
  "food_name", "ingredients", "additives", "net_content", "barcode", "spec",
  "producer", "address", "contact", "production_date", "shelf_life",
  "expiry_date", "storage", "license_no", "standard_code", "quality_grade",
  "allergens", "claims", "nutrition_warning", "other_text",
];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderThumbs() {
  thumbs.innerHTML = "";
  files.forEach((f, i) => {
    const d = document.createElement("div");
    if (f.kind === "doc") {
      d.className = "thumb doc";
      d.innerHTML = `<div class="docicon">页</div><div class="docname">${esc(f.file.name)}</div><button title="移除" data-i="${i}">×</button>`;
    } else {
      d.className = "thumb";
      d.innerHTML = `<img src="${f.url}" alt=""><button title="移除" data-i="${i}">×</button>`;
    }
    thumbs.appendChild(d);
  });
  runBtn.disabled = files.length === 0;
  resetBtn.hidden = files.length === 0;
}

// 文档（非图片）判定：按扩展名或 MIME。这些文件已是文字，后端会跳过 OCR 直接比对。
const DOC_EXT_RE = /\.(pdf|docx?|txt|md|csv)$/i;
function isDocFile(file) {
  return DOC_EXT_RE.test(file.name || "") ||
    /pdf|word|officedocument|^text\//.test(file.type || "");
}

function addFiles(list) {
  for (const file of list) {
    if (files.length >= 4) break;
    if (file.type && file.type.startsWith("image/")) {
      files.push({ file, url: URL.createObjectURL(file), kind: "image" });
    } else if (isDocFile(file)) {
      files.push({ file, url: "", kind: "doc" });
    } // 其余类型忽略
  }
  renderThumbs();
}

thumbs.addEventListener("click", (e) => {
  const i = e.target.getAttribute && e.target.getAttribute("data-i");
  if (i !== null && i !== undefined) {
    const f = files[Number(i)];
    if (f && f.url) URL.revokeObjectURL(f.url);
    files.splice(Number(i), 1);
    renderThumbs();
  }
});

$("pick").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

const drop = $("drop");
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", (e) => { if (e.dataTransfer) addFiles(e.dataTransfer.files); });

// 直接粘贴剪贴板里的图片（截图、网页复制的图片等）。图片通常不在
// clipboardData.files 里，而是以 blob 形式出现在 clipboardData.items，需用
// getAsFile() 取出；同时兼容 .files 路径。
window.addEventListener("paste", (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const picked = [];
  if (cd.items && cd.items.length) {
    for (const item of cd.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          // 粘贴的截图往往没有文件名，补一个带扩展名的名字便于后端识别。
          const ext = (blob.type.split("/")[1] || "png").split("+")[0];
          const named = blob.name
            ? blob
            : new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type });
          picked.push(named);
        }
      }
    }
  }
  if (!picked.length && cd.files && cd.files.length) {
    for (const f of cd.files) if (f.type.startsWith("image/")) picked.push(f);
  }
  if (picked.length) {
    e.preventDefault();
    addFiles(picked);
  }
});

resetBtn.addEventListener("click", () => {
  streamToken++; // 让正在进行的拉流循环失效
  clearJob();
  files.forEach((f) => { if (f.url) URL.revokeObjectURL(f.url); });
  files = [];
  renderThumbs();
  reportEl.hidden = true;
  statusEl.hidden = true;
  runBtn.disabled = false;
  resetSteps();
});

// 步骤进度条控制
const STEP_LABELS = { 1: "识别图片", 2: "识读内容", 3: "对照国标", 4: "生成报告" };
function setStep(n, state) {
  // state: active | done。点亮第 n 步，并把之前的步标记为 done。
  const stepsEl = $("steps");
  stepsEl.hidden = false;
  stepsEl.querySelectorAll(".step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.remove("active", "done");
    if (s < n) el.classList.add("done");
    else if (s === n) el.classList.add(state === "done" ? "done" : "active");
  });
}
function resetSteps() {
  const stepsEl = $("steps");
  stepsEl.hidden = true;
  stepsEl.querySelectorAll(".step").forEach((el) => {
    el.classList.remove("active", "done");
    const t = el.querySelector(".time");
    if (t) t.textContent = "";
  });
}

// 在某步标签下标记耗时（秒）。prefix 用于区分单步耗时与总耗时。
function setStepTime(n, secs, prefix) {
  if (typeof secs !== "number" || !isFinite(secs)) return;
  const stepsEl = $("steps");
  const el = stepsEl.querySelector(`.step[data-step="${n}"]`);
  if (!el) return;
  let t = el.querySelector(".time");
  if (!t) {
    t = document.createElement("span");
    t.className = "time";
    el.appendChild(t);
  }
  t.textContent = (prefix || "") + secs.toFixed(1) + "s";
}

runBtn.addEventListener("click", async () => {
  if (!files.length) return;
  runBtn.disabled = true;
  reportEl.hidden = true;
  statusEl.hidden = true;
  resetSteps();
  // 预清空报告各区，准备逐步填充
  clearReport();

  const fd = new FormData();
  files.forEach((f) => {
    if (f.kind === "doc") fd.append("docs", f.file, f.file.name);
    else fd.append("images", f.file, f.file.name);
  });
  // 生成本次上传项的轻量缩略图（图片压成小 dataURL，文档记文件名），随 job 持久化供刷新恢复。
  const thumbs = await buildThumbs(files);

  try {
    // 先启动后台任务，拿到 job_id（处理脱离本请求，切页/刷新都不中断）。
    const resp = await fetch(api("api/check/start"), { method: "POST", body: fd });
    if (!resp.ok) {
      let msg = `请求失败 (${resp.status})`;
      try { msg = (await resp.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    const { job_id } = await resp.json();
    if (!job_id) throw new Error("未能创建检查任务");
    saveJob(job_id, thumbs);
    // 拉取事件流（可重连续接）；从头回放。
    await streamJob(job_id, 0);
  } catch (err) {
    statusEl.hidden = false;
    statusEl.className = "status err";
    statusEl.textContent = "出错了：" + err.message;
    runBtn.disabled = false;
  }
});

// 为持久化生成轻量缩略图：图片缩到 ≤160px 的 JPEG dataURL（省 localStorage），文档只记文件名。
async function buildThumbs(list) {
  const out = [];
  for (const f of list) {
    if (f.kind === "doc") {
      out.push({ kind: "doc", name: f.file.name });
    } else {
      try {
        out.push({ kind: "image", url: await shrinkToDataURL(f.url, 160) });
      } catch (e) {
        // 压缩失败就跳过该图缩略（不影响检查恢复）
      }
    }
  }
  return out;
}
function shrinkToDataURL(srcUrl, maxEdge) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      try { resolve(cv.toDataURL("image/jpeg", 0.7)); } catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = srcUrl;
  });
}

// ── 后台任务：持久化 job_id，切页/刷新/断线都能续接，不中断处理 ──
const JOB_KEY = "foodlabel_job_v1";
// 任务最长跟踪时长（毫秒）；超过则视为过期，刷新后不再尝试恢复。
const JOB_MAX_AGE = 30 * 60 * 1000;
// 流令牌：每次新检查/恢复/重置都自增，使旧的拉流循环自动失效（避免重置后仍在更新 UI）。
let streamToken = 0;

// 保存任务 id + 本次上传项的缩略图（图片存压缩 dataURL，文档存文件名），
// 以便刷新后恢复“已上传的图片”预览，不只是检查进度。
function saveJob(id, thumbs) {
  try { localStorage.setItem(JOB_KEY, JSON.stringify({ id, ts: Date.now(), thumbs: thumbs || [] })); } catch (e) {}
}
function loadJob() {
  try {
    const j = JSON.parse(localStorage.getItem(JOB_KEY) || "null");
    if (j && j.id && Date.now() - (j.ts || 0) < JOB_MAX_AGE) return j;
  } catch (e) {}
  return null;
}
function clearJob() {
  try { localStorage.removeItem(JOB_KEY); } catch (e) {}
}

function _isTerminal(ev) {
  return (ev.stage === "done" && ev.status === "done") || ev.stage === "error";
}

// 拉取并消费某任务的事件流，支持断线/超时自动重连续接（从已收到的事件数续拉）。
async function streamJob(jobId, fromIndex) {
  const myToken = ++streamToken;
  let idx = fromIndex || 0;
  let finished = false;
  while (!finished && myToken === streamToken) {
    let resp;
    try {
      resp = await fetch(api(`api/check/stream?job_id=${encodeURIComponent(jobId)}&from=${idx}`));
    } catch (netErr) {
      await sleep(1500);
      continue; // 网络抖动：稍后用当前 idx 重连续接
    }
    if (myToken !== streamToken) return; // 已被新检查/重置取代
    if (resp.status === 404) {
      // 任务已过期/服务重启：清掉，停止恢复（避免无意义重试）。
      clearJob();
      runBtn.disabled = false;
      return;
    }
    if (!resp.ok || !resp.body) {
      await sleep(1500);
      continue;
    }
    try {
      await consumeSSE(resp.body, (ev) => {
        if (myToken !== streamToken) return;
        idx++;
        if (_isTerminal(ev)) finished = true;
        // 恢复中的提示在收到首个事件后撤掉
        if (statusEl.textContent === "正在恢复上次的检查进度…") statusEl.hidden = true;
        onStepEvent(ev);
      });
    } catch (streamErr) {
      // 流中断：若任务尚未完成，用最新 idx 续接。
    }
    if (myToken !== streamToken) return;
    if (!finished) await sleep(1200);
  }
  if (myToken !== streamToken) return;
  clearJob();
  runBtn.disabled = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 页面加载：若有未完成的检查任务，自动恢复进度（回放已完成步骤并续接后续）。
function resumeJobIfAny() {
  const j = loadJob();
  if (!j) return;
  resetSteps();
  clearReport();
  // 恢复“已上传的图片/文档”缩略图，让刷新后仍能看到自己传的内容。
  if (Array.isArray(j.thumbs) && j.thumbs.length) {
    renderRestoredThumbs(j.thumbs);
  }
  statusEl.hidden = false;
  statusEl.className = "status";
  statusEl.textContent = "正在恢复上次的检查进度…";
  runBtn.disabled = true;
  streamJob(j.id, 0);
}
resumeJobIfAny();

// 刷新恢复时重建缩略图展示（只用于展示，原始文件已随请求上传、任务在服务端跑，无需重传）。
function renderRestoredThumbs(list) {
  const box = $("thumbs");
  if (!box) return;
  box.innerHTML = "";
  list.forEach((t) => {
    const d = document.createElement("div");
    if (t.kind === "doc") {
      d.className = "thumb doc";
      d.innerHTML = `<div class="docicon">页</div><div class="docname">${esc(t.name || "文档")}</div>`;
    } else {
      d.className = "thumb";
      d.innerHTML = `<img src="${t.url}" alt="">`;
    }
    box.appendChild(d);
  });
}

// 读取 SSE 流，逐行解析 `data: {...}` 事件
async function consumeSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try { onEvent(JSON.parse(line.slice(5).trim())); } catch (e) {}
    }
  }
}

// 处理每个阶段事件：点亮进度条 + 逐步渲染
function onStepEvent(ev) {
  if (ev.stage === "error") {
    statusEl.hidden = false;
    statusEl.className = "status err";
    statusEl.textContent = "出错了：" + (ev.error || "未知错误");
    return;
  }
  // 纯文档输入时后端会把第 1 步 label 改成“读取标签文本”，同步更新进度条文案。
  if (ev.stage === "ocr" && ev.label) {
    const s1 = $("steps").querySelector('.step[data-step="1"] .lbl');
    if (s1) s1.textContent = ev.label;
  }
  const step = ev.step || 0;
  if (ev.status === "started") {
    setStep(step, "active");
    return;
  }
  if (ev.status !== "done") return;

  if (ev.stage === "extract") {
    // 第 2 步完成：先展示识读字段 + 营养表
    setStep(2, "done");
    setStepTime(2, ev.elapsed);
    reportEl.hidden = false;
    renderExtracted(ev);
    reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (ev.stage === "ocr") {
    setStep(1, "done");
    setStepTime(1, ev.elapsed);
  } else if (ev.stage === "rules") {
    // 第 3 步完成：展示适用规则（食品类目 + 各项适用/豁免，检查结果列暂为待评价）
    setStep(3, "done");
    setStepTime(3, ev.elapsed);
    reportEl.hidden = false;
    renderRules(ev.rules || {});
  } else if (ev.stage === "analyze") {
    // 第 4 步完成：合规评价耗时
    setStep(4, "done");
    setStepTime(4, ev.elapsed);
  } else if (ev.stage === "done") {
    // 第 5 步完成：渲染完整合规结论
    setStep(5, "done");
    setStepTime(5, ev.elapsed_total, "共 ");
    const data = ev.result || {};
    renderExtracted(data);
    renderRules(data.rules, data.checks);
    renderVerdict(data);
    renderFindings("missing", data.missing);
    renderFindings("problems", data.problems);
    renderFindings("risks", data.risks);
    reportEl.hidden = false;
    addHistory(data);
  }
}

// 清空报告各区，准备逐步填充
function clearReport() {
  const fp = $("fingerprint");
  if (fp) { fp.hidden = true; fp.innerHTML = ""; }
  $("verdict").innerHTML = "";
  $("verdict").className = "verdict";
  $("extracted").innerHTML = "";
  $("nutriWrap").hidden = true;
  $("rulesBox").hidden = true;
  ["missing", "problems", "risks"].forEach((k) => {
    $(k + "List").innerHTML = "";
    $(k + "Count").textContent = "0";
  });
  $("suggBox").hidden = true;
}

// 产品指纹：让不同产品的报告一眼可区分（食品名称 · 净含量 · 条码）
function renderFingerprint(data) {
  const box = $("fingerprint");
  if (!box) return;
  const ex = data.extracted || {};
  const name = (typeof ex.food_name === "string" ? ex.food_name.trim() : "") || "未识读到名称";
  const meta = [];
  const nc = typeof ex.net_content === "string" ? ex.net_content.trim() : "";
  if (nc) meta.push(esc(nc));
  const bc = typeof ex.barcode === "string" ? ex.barcode.trim() : "";
  if (bc) meta.push("条码 " + esc(bc));
  box.innerHTML =
    `<span class="fp-tag">产品</span>` +
    `<span class="fp-name">${esc(name)}</span>` +
    (meta.length ? `<span class="fp-meta">${meta.join("　·　")}</span>` : "");
  box.hidden = false;
}

// 渲染识读字段 + 营养成分表（步骤2完成即可显示）
function renderExtracted(data) {
  renderFingerprint(data);
  const ex = data.extracted || {};
  const kv = $("extracted");
  kv.innerHTML = "";
  FIELD_ORDER.forEach((key) => {
    const val = ex[key];
    if (val === undefined || val === null || val === "") return;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="k">${esc(FIELD_LABEL[key] || key)}</td><td>${esc(val)}</td>`;
    kv.appendChild(tr);
  });
  if (!kv.children.length) {
    kv.innerHTML = `<tr><td class="k">—</td><td>未识读到结构化字段。</td></tr>`;
  }
  const nt = Array.isArray(ex.nutrition_table) ? ex.nutrition_table : [];
  const wrap = $("nutriWrap");
  const ntbl = $("nutrition");
  if (nt.length) {
    ntbl.innerHTML = `<tr><th>项目</th><th>每100g/mL或每份</th><th>NRV%</th></tr>` +
      nt.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.value)}</td><td>${esc(r.nrv)}</td></tr>`).join("");
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

// 渲染适用规则 + 合规检查（合并为一张表：项目 | 适用性 | 检查结果 | 说明）
// 第 3 步完成时只有适用性（checks 为空，适用项显示“待评价”）；第 5 步带 checks 回填结果。
function renderRules(rules, checks) {
  if (!rules || !rules.category_name) { $("rulesBox").hidden = true; return; }
  const imp = rules.is_import ? " \u00b7 \u8fdb\u53e3\u98df\u54c1" : "";
  $("rulesCat").textContent = rules.category_name + (rules.category_basis ? "\uff08" + rules.category_basis + "\uff09" : "") + imp;
  $("rulesReason").textContent = rules.category_reason || "";
  const list = Array.isArray(rules.applicable) ? rules.applicable : [];
  const checkById = {};
  (Array.isArray(checks) ? checks : []).forEach((c) => { if (c && c.id) checkById[c.id] = c; });
  const head = `<tr><th class="it">\u9879\u76ee</th><th class="st">\u9002\u7528\u6027</th><th class="st">\u68c0\u67e5\u7ed3\u679c</th><th>\u8bf4\u660e</th></tr>`;
  const rows = list.map((a) => {
    const ok = a.applicable;
    const appTag = ok
      ? `<span class="b pass">\u9002\u7528</span>`
      : `<span class="b na">\u8c41\u514d</span>`;
    const c = checkById[a.id];
    let resTag, note, rowcls = "";
    if (!ok) {
      // 豁免项：检查结果固定不适用，说明用豁免理由
      resTag = `<span class="b na">${STATUS_LABEL.na}</span>`;
      note = a.reason || "";
    } else if (c) {
      const st = (c.status || "unknown").toLowerCase();
      const cls = ["pass", "miss", "fail", "warn", "na", "unknown"].includes(st) ? st : "unknown";
      resTag = `<span class="b ${cls}">${STATUS_LABEL[cls]}</span>`;
      // 符合(pass)项不写多余说明（留空）；其余状态显示 finding，无则回退适用理由
      note = st === "pass" ? (c.finding || "") : (c.finding || a.reason || "");
      rowcls = (st === "miss" || st === "fail") ? "row-fail" : st === "warn" ? "row-warn" : "";
    } else {
      // 第 3 步阶段：尚未评价
      resTag = `<span class="b pending">\u5f85\u8bc4\u4ef7</span>`;
      note = a.reason || "";
    }
    const basis = (c && c.basis) || a.basis || "";
    return `<tr class="${rowcls}">
      <td class="it">${esc(a.item)}<span class="basis">${esc(basis)}</span></td>
      <td class="st">${appTag}</td>
      <td class="st">${resTag}</td>
      <td>${esc(note)}</td>
    </tr>`;
  }).join("");
  $("rulesTable").innerHTML = head + rows;
  $("rulesBox").hidden = false;
}

// 渲染合规结论卡片
function renderVerdict(data) {
  const summary = data.summary || {};
  const verdict = summary.verdict || "issues";
  const v = $("verdict");
  v.className = "verdict v-" + verdict;
  let score = "";
  if (typeof summary.score === "number") score = `<span class="score">合规评分 ${summary.score}/100</span>`;
  const counts = `符合 ${summary.pass || 0} · 缺失 ${summary.miss || 0} · 不符合 ${summary.fail || 0} · 需复核 ${summary.warn || 0}`;
  v.innerHTML = `${score}${esc(VERDICT_LABEL[verdict] || verdict)}<div class="sub" style="font-weight:400;font-size:13px;margin-top:4px;">${counts}</div>`;
}

const LEVEL_LABEL = { high: "高", medium: "中", low: "低" };

// 渲染 缺失/问题/风险 列表（结构相同：item + detail + basis + suggestion[+level]）
function renderFindings(kind, list) {
  const box = $(kind + "Box");
  const ul = $(kind + "List");
  const arr = Array.isArray(list) ? list : [];
  $(kind + "Count").textContent = arr.length;
  if (!arr.length) {
    ul.innerHTML = `<li class="empty">未发现。</li>`;
    return;
  }
  ul.innerHTML = arr.map((x) => {
    const lvl = x.level ? `<span class="lvl lvl-${esc(x.level)}">${LEVEL_LABEL[x.level] || esc(x.level)}风险</span>` : "";
    const basis = x.basis ? `<span class="basis">依据：${esc(x.basis)}</span>` : "";
    const sug = x.suggestion ? `<div class="sug">整改建议：${esc(x.suggestion)}</div>` : "";
    return `<li>
      <div class="fh">${lvl}<strong>${esc(x.item || "")}</strong></div>
      <div class="fd">${esc(x.detail || "")}</div>
      ${basis}${sug}
    </li>`;
  }).join("");
}

// 顶部显示当前依据的标准
fetch(api("api/health")).then((r) => r.json()).then((d) => {
  if (d.standards) $("standards").textContent = d.standards;
}).catch(() => {});

// ───────────────────────────── 识别历史（仅本地 localStorage）─────────────────────────────
// 历史只存在用户当前浏览器，不上传服务器。每条存：时间、结论、评分、食品名、完整 result（供回看）。
const HISTORY_KEY = "foodlabel_history_v1";
const HISTORY_MAX = 30; // 最多保留条数，超出丢弃最旧

function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveHistory(arr) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, HISTORY_MAX))); } catch (e) {}
}
function addHistory(result) {
  if (!result || !result.summary) return;
  const ex = result.extracted || {};
  const entry = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    verdict: result.summary.verdict || "issues",
    score: typeof result.summary.score === "number" ? result.summary.score : null,
    food_name: (typeof ex.food_name === "string" ? ex.food_name : "") || "未识读到名称",
    result,
  };
  const arr = loadHistory();
  arr.unshift(entry);
  saveHistory(arr);
  renderHistory();
}
function deleteHistory(id) {
  saveHistory(loadHistory().filter((e) => e.id !== id));
  renderHistory();
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderHistory() {
  const ul = $("historyList");
  if (!ul) return;
  const arr = loadHistory();
  const empty = $("historyEmpty");
  const clearBtn = $("historyClear");
  if (empty) empty.hidden = arr.length > 0;
  if (clearBtn) clearBtn.hidden = arr.length === 0;
  ul.innerHTML = arr.map((e) => {
    const vcls = "v-" + (e.verdict || "issues");
    const vlabel = VERDICT_LABEL[e.verdict] || "已检查";
    const score = e.score !== null && e.score !== undefined ? `<span class="hscore">${e.score}/100</span>` : "";
    return `<li class="history-item" data-id="${e.id}">
      <div class="hi-main">
        <div class="hi-name">${esc(e.food_name)}</div>
        <div class="hi-meta"><span class="hv ${vcls}">${esc(vlabel)}</span>${score}<span class="htime">${fmtTime(e.ts)}</span></div>
      </div>
      <button class="hi-del" data-del="${e.id}" title="删除">×</button>
    </li>`;
  }).join("");
}
// 点击历史项查看；点删除按钮删除
$("historyList").addEventListener("click", (e) => {
  const del = e.target.getAttribute && e.target.getAttribute("data-del");
  if (del) { deleteHistory(del); return; }
  const li = e.target.closest && e.target.closest(".history-item");
  if (!li) return;
  const id = li.getAttribute("data-id");
  const entry = loadHistory().find((x) => x.id === id);
  if (!entry) return;
  // 用存的 result 复用渲染函数回看报告
  clearReport();
  resetSteps();
  const data = entry.result;
  renderExtracted(data);
  renderRules(data.rules, data.checks);
  renderVerdict(data);
  renderFindings("missing", data.missing);
  renderFindings("problems", data.problems);
  renderFindings("risks", data.risks);
  reportEl.hidden = false;
  reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("historyClear").addEventListener("click", () => {
  if (loadHistory().length && confirm("确定清空全部识别历史？")) {
    saveHistory([]);
    renderHistory();
  }
});
renderHistory();


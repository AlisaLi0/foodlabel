/* 标签识别 前端逻辑：选图/拖拽/粘贴 → POST /api/check → 渲染合规报告 */
"use strict";

// 后端 API base。前后端分离：前端可单独部署，指向任意后端。解析顺序：
//   1. window.FOODLABEL_API_BASE（index.html 内联设置）
//   2. <meta name="foodlabel-api-base" content="https://...">
//   3. ""（同源，相对 <base href> 解析为 /biaoqianshibie/api/*）
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
  pass: "符合", fail: "不符合", warn: "需复核", na: "不适用", unknown: "看不清",
};
const VERDICT_LABEL = {
  compliant: "标签基本符合国家标准要求",
  issues: "标签存在需复核或不规范之处",
  non_compliant: "标签存在不符合国家标准的问题",
  not_a_label: "未能识别为食品标签",
};
const FIELD_LABEL = {
  food_name: "食品名称", ingredients: "配料表", additives: "食品添加剂",
  net_content: "净含量", spec: "规格", producer: "生产者/经营者",
  address: "地址", contact: "联系方式", production_date: "生产日期",
  shelf_life: "保质期", expiry_date: "保质期到期日", storage: "贮存条件",
  license_no: "生产许可证编号", standard_code: "产品标准代号",
  quality_grade: "质量等级", allergens: "致敏物质", claims: "声称/强调",
  nutrition_warning: "盐油糖提示语", other_text: "其他文字",
};
const FIELD_ORDER = [
  "food_name", "ingredients", "additives", "net_content", "spec",
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
    d.className = "thumb";
    d.innerHTML = `<img src="${f.url}" alt=""><button title="移除" data-i="${i}">×</button>`;
    thumbs.appendChild(d);
  });
  runBtn.disabled = files.length === 0;
  resetBtn.hidden = files.length === 0;
}

function addFiles(list) {
  for (const file of list) {
    if (!file.type.startsWith("image/")) continue;
    if (files.length >= 4) break;
    files.push({ file, url: URL.createObjectURL(file) });
  }
  renderThumbs();
}

thumbs.addEventListener("click", (e) => {
  const i = e.target.getAttribute && e.target.getAttribute("data-i");
  if (i !== null && i !== undefined) {
    URL.revokeObjectURL(files[i].url);
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
  files.forEach((f) => URL.revokeObjectURL(f.url));
  files = [];
  renderThumbs();
  reportEl.hidden = true;
  statusEl.hidden = true;
});

runBtn.addEventListener("click", async () => {
  if (!files.length) return;
  runBtn.disabled = true;
  reportEl.hidden = true;
  statusEl.hidden = false;
  statusEl.className = "status";
  statusEl.innerHTML = `<div class="spinner"></div><div>正在识读图片并对照国家标准检查，请稍候…</div>`;

  const fd = new FormData();
  files.forEach((f) => fd.append("images", f.file, f.file.name));

  try {
    const resp = await fetch(api("api/check"), { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `请求失败 (${resp.status})`);
    statusEl.hidden = true;
    render(data);
  } catch (err) {
    statusEl.className = "status err";
    statusEl.textContent = "出错了：" + err.message;
  } finally {
    runBtn.disabled = false;
  }
});

function render(data) {
  const summary = data.summary || {};
  const verdict = summary.verdict || "issues";
  const v = $("verdict");
  v.className = "verdict v-" + verdict;
  let score = "";
  if (typeof summary.score === "number") score = `<span class="score">合规评分 ${summary.score}/100</span>`;
  const counts = `符合 ${summary.pass || 0} · 不符合 ${summary.fail || 0} · 需复核 ${summary.warn || 0}`;
  v.innerHTML = `${score}${esc(VERDICT_LABEL[verdict] || verdict)}<div class="sub" style="font-weight:400;font-size:13px;margin-top:4px;">${counts}</div>`;

  // 识读字段
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

  // 营养成分表
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

  // 检查项
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const order = { fail: 0, warn: 1, unknown: 2, pass: 3, na: 4 };
  checks.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const ctbl = $("checks");
  ctbl.innerHTML = checks.map((c) => {
    const st = (c.status || "unknown").toLowerCase();
    const cls = ["pass", "fail", "warn", "na", "unknown"].includes(st) ? st : "unknown";
    const rowcls = st === "fail" ? "row-fail" : st === "warn" ? "row-warn" : "";
    return `<tr class="${rowcls}">
      <td class="st"><span class="b ${cls}">${STATUS_LABEL[cls]}</span></td>
      <td class="it">${esc(c.item)}<span class="basis">${esc(c.basis || "")}</span></td>
      <td>${esc(c.finding || "")}</td>
    </tr>`;
  }).join("");

  // 缺失点 / 问题点 / 风险点
  renderFindings("missing", data.missing);
  renderFindings("problems", data.problems);
  renderFindings("risks", data.risks);

  // 识别过程：各 OCR 原文 + 评价
  renderOcr(data);

  // 兼容旧版 suggestions（新版用 missing/problems/risks，一般为空）
  const sugg = Array.isArray(data.suggestions) ? data.suggestions.filter(Boolean) : [];
  const sbox = $("suggBox");
  if (sugg.length) {
    $("suggestions").innerHTML = sugg.map((s) => `<li>${esc(s)}</li>`).join("");
    sbox.hidden = false;
  } else {
    sbox.hidden = true;
  }

  reportEl.hidden = false;
  reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
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

// 渲染 OCR 识别过程：各模型原文 + R1 评价分数
function renderOcr(data) {
  const box = $("ocrBox");
  const results = Array.isArray(data.ocr_results) ? data.ocr_results : [];
  if (!results.length) { box.hidden = true; return; }
  const evals = (data.ocr_evaluation && data.ocr_evaluation.evaluations) || [];
  const scoreOf = (m) => {
    const e = evals.find((x) => x.model === m);
    return e && (e.score != null) ? e.score : null;
  };
  const wrap = $("ocrResults");
  wrap.innerHTML = results.map((r) => {
    const name = r.model.split("/").pop();
    const sc = scoreOf(r.model);
    const badge = sc != null ? `<span class="score">可信度 ${esc(sc)}</span>` : "";
    const body = r.error
      ? `<div class="ocr-err">识别失败：${esc(r.error)}</div>`
      : `<pre>${esc(r.text || "(无输出)")}</pre>`;
    return `<div class="ocr-one"><div class="ocr-h">${esc(name)}${badge}</div>${body}</div>`;
  }).join("");
  const conf = data.ocr_evaluation && data.ocr_evaluation.confidence;
  $("mergedText").textContent = data.merged_text || "";
  $("ocrConf").textContent = conf != null ? `融合可信度 ${conf}` : "";
  box.hidden = false;
}

// 顶部显示当前依据的标准
fetch(api("api/health")).then((r) => r.json()).then((d) => {
  if (d.standards) $("standards").textContent = d.standards;
}).catch(() => {});

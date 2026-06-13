/* 法规与标准原文：左侧导航 + 右侧单篇内容（按 hash 路由切换不同文档）。 */
"use strict";

// 文档清单：每篇一个“页面”，由左侧边栏导航切换。group 用于分组标题。
const DOCS = [
  {
    id: "gb7718",
    group: "GB 7718-2025 预包装食品标签通则",
    nav: "标准正文",
    title: "GB 7718-2025 食品安全国家标准 预包装食品标签通则",
    sub: "2025-03-16 发布 · 2027-03-16 实施 · 国家卫生健康委员会、国家市场监督管理总局 发布（代替 GB 7718-2011）",
    links: [
      { label: "官方发布公告：卫健委 2025年第2号", url: "https://www.nhc.gov.cn/sps/c100088/202503/e8a432507f7d4f08a877e76a9b0578ce.shtml", src: true },
      { label: "下载本页文本", url: "docs/gb7718-2025.txt" },
    ],
    note: "国家卫生健康委、国家市场监督管理总局 2025-03-27 以「2025年第2号公告」正式发布 GB 7718-2025。",
    file: "docs/gb7718-2025.txt",
    fmt: "txt",
  },
  {
    id: "gb7718-interpret",
    group: "GB 7718-2025 预包装食品标签通则",
    nav: "官方解读",
    title: "GB 7718-2025 官方解读材料",
    sub: "国家卫生健康委、国家市场监督管理总局 2025-03-16 发布",
    links: [
      { label: "官方问答：GB 7718-2025（2025-09-25）", url: "https://www.nhc.gov.cn/sps/c100087/202509/bc824a504ec34c27883da73f14c20d44.shtml", src: true },
      { label: "下载解读文本", url: "docs/gb7718-2025-interpret.txt" },
    ],
    note: "",
    file: "docs/gb7718-2025-interpret.txt",
    fmt: "txt",
  },
  {
    id: "gb28050",
    group: "GB 28050-2025 预包装食品营养标签通则",
    nav: "标准正文",
    title: "GB 28050-2025 食品安全国家标准 预包装食品营养标签通则",
    sub: "2025-03-16 发布 · 2027-03-16 实施 · 国家卫生健康委员会、国家市场监督管理总局 发布（代替 GB 28050-2011）",
    links: [
      { label: "官方发布公告：卫健委 2025年第2号", url: "https://www.nhc.gov.cn/sps/c100088/202503/e8a432507f7d4f08a877e76a9b0578ce.shtml", src: true },
      { label: "下载本页文本", url: "docs/gb28050-2025.txt" },
    ],
    note: "国家卫生健康委、国家市场监督管理总局 2025-03-27 以「2025年第2号公告」正式发布 GB 28050-2025。",
    file: "docs/gb28050-2025.txt",
    fmt: "txt",
  },
  {
    id: "gb28050-qa",
    group: "GB 28050-2025 预包装食品营养标签通则",
    nav: "官方问答",
    title: "GB 28050-2025 官方问答",
    sub: "国家卫生健康委食品安全标准与监测评估司 2025-09-25 发布",
    links: [
      { label: "官方问答：GB 28050-2025（2025-09-25）", url: "https://www.nhc.gov.cn/sps/c100087/202509/470fa4ff5de14dd38619223cce9da4e7.shtml", src: true },
      { label: "下载问答文本", url: "docs/gb28050-2025-qa.txt" },
    ],
    note: "",
    file: "docs/gb28050-2025-qa.txt",
    fmt: "txt",
  },
  {
    id: "decree100",
    group: "部门规章",
    nav: "食品标识监督管理办法",
    title: "食品标识监督管理办法（国家市场监督管理总局令第 100 号）",
    sub: "2025-03-14 公布 · 2027-03-16 施行 · 国家市场监督管理总局（共 7 章 54 条）",
    links: [
      { label: "官方来源：司法部 部门规章库", url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202511/t20251106_527628.html", src: true },
      { label: "国家市场监督管理总局", url: "https://www.samr.gov.cn/" },
      { label: "下载本页文本", url: "docs/decree-100.md" },
    ],
    note: "《食品标识监督管理办法》（国家市场监督管理总局令第100号）由司法部「国家法律法规数据库 / 部门规章」收录全文。",
    file: "docs/decree-100.md",
    fmt: "md",
  },
];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// 纯文本（GB 标准）：把“N 标题”形式的章标题提为小标题，其余原样（容器 pre-wrap 保留换行）。
function renderTxt(text) {
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (/^\d{1,2}\s+[\u4e00-\u9fff]/.test(t) && t.length <= 24) {
      return `<h3>${esc(t)}</h3>`;
    }
    return esc(line);
  }).join("\n");
}

// 轻量 Markdown（总局令）：## 小标题、**加粗**、> 引用，其余段落。
function renderMd(text) {
  return text.split("\n").map((line) => {
    if (/^#\s+/.test(line)) return "";
    if (/^##\s+/.test(line)) return `<h3>${esc(line.replace(/^##\s+/, ""))}</h3>`;
    if (/^>\s?/.test(line)) return `<div class="q">${esc(line.replace(/^>\s?/, ""))}</div>`;
    return esc(line).replace(/\*\*(.+?)\*\*/g, '<span class="art">$1</span>');
  }).join("\n");
}

// 渲染左侧导航（按 group 分组）
function buildNav() {
  const nav = document.getElementById("docsNav");
  let html = "";
  let lastGroup = null;
  DOCS.forEach((d) => {
    if (d.group !== lastGroup) {
      html += `<div class="nav-group-t">${esc(d.group)}</div>`;
      lastGroup = d.group;
    }
    html += `<a class="nav-item" data-id="${d.id}" href="#${d.id}">${esc(d.nav)}</a>`;
  });
  nav.innerHTML = html;
}

const _textCache = {};

function loadText(doc, target) {
  if (_textCache[doc.id] != null) {
    target.innerHTML = _textCache[doc.id];
    return;
  }
  target.innerHTML = '<span class="loading">加载中…</span>';
  fetch(doc.file).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then((text) => {
    const html = doc.fmt === "md" ? renderMd(text) : renderTxt(text);
    _textCache[doc.id] = html;
    target.innerHTML = html;
  }).catch((e) => {
    target.innerHTML = '<span class="loading err">加载失败：' + esc(e.message) + "</span>";
  });
}

// 渲染右侧单篇内容
function renderDoc(doc) {
  const links = doc.links.map((l) =>
    `<a class="${l.src ? "src" : ""}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`
  ).join("");
  const note = doc.note ? `<p class="src-note">${esc(doc.note)}</p>` : "";
  const content = document.getElementById("docsContent");
  content.innerHTML =
    `<h1 class="doc-title">${esc(doc.title)}</h1>` +
    `<p class="doc-sub">${esc(doc.sub)}</p>` +
    `<div class="doc-links">${links}</div>` +
    note +
    `<div class="doctext" id="docText">—</div>`;
  loadText(doc, document.getElementById("docText"));
  document.querySelectorAll("#docsNav .nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.id === doc.id);
  });
  window.scrollTo({ top: 0, behavior: "auto" });
}

function currentDoc() {
  const id = (location.hash || "").replace(/^#/, "");
  return DOCS.find((d) => d.id === id) || DOCS[0];
}

buildNav();
renderDoc(currentDoc());
window.addEventListener("hashchange", () => renderDoc(currentDoc()));

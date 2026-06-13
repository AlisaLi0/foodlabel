/* 法规与标准原文页：折叠时懒加载对应文件并渲染。 */
"use strict";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// 纯文本（GB 标准）：转义后，把"N 标题"形式的章标题提为小标题，其余原样（容器 pre-wrap 保留换行）。
function renderTxt(text) {
  return text.split("\n").map((line) => {
    const t = line.trim();
    // 章标题：单个数字 + 空格 + 中文（如「1 范围」「4 基本要求」「8 ...」）
    if (/^\d{1,2}\s+[\u4e00-\u9fff]/.test(t) && t.length <= 24) {
      return `<h3>${esc(t)}</h3>`;
    }
    return esc(line);
  }).join("\n");
}

// 轻量 Markdown（总局令）：## 小标题、**加粗**、> 引用、- 列表，其余段落。
function renderMd(text) {
  return text.split("\n").map((line) => {
    if (/^#\s+/.test(line)) return ""; // 顶层标题已在卡片头展示
    if (/^##\s+/.test(line)) return `<h3>${esc(line.replace(/^##\s+/, ""))}</h3>`;
    if (/^>\s?/.test(line)) return `<div class="q">${esc(line.replace(/^>\s?/, ""))}</div>`;
    // 先转义，再把 **...** 还原成加粗
    return esc(line).replace(/\*\*(.+?)\*\*/g, '<span class="art">$1</span>');
  }).join("\n");
}

function loadInto(details, url, fmt) {
  const target = details.querySelector("[data-target]");
  if (!target || target.dataset.loaded) return;
  target.dataset.loaded = "1";
  target.innerHTML = '<span class="loading">加载中…</span>';
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then((text) => {
    target.innerHTML = fmt === "md" ? renderMd(text) : renderTxt(text);
  }).catch((e) => {
    target.dataset.loaded = "";
    target.innerHTML = '<span class="loading">加载失败：' + esc(e.message) + "</span>";
  });
}

// 每个可折叠块展开时懒加载其文档。文档来源优先取 details 自身的 data-doc，
// 否则回退到所属卡片的 data-doc（主文件全文）。
document.querySelectorAll("details.fulltext").forEach((details) => {
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    const card = details.closest(".doc-card");
    const url = details.getAttribute("data-doc") || (card && card.getAttribute("data-doc"));
    const fmt = details.getAttribute("data-fmt") || (card && card.getAttribute("data-fmt")) || "txt";
    if (url) loadInto(details, url, fmt);
  });
});

/* 法规与标准原文：左侧导航 + 右侧单篇内容（按 hash 路由切换不同文档）。 */
"use strict";

// 文档清单：每篇一个“页面”，由左侧边栏导航切换。group 用于分组标题。
const DOCS = [
  {
    id: "gb7718",
    group: "GB 7718-2025 预包装食品标签通则",
    nav: "标准原文（PDF）",
    title: "GB 7718-2025 食品安全国家标准 预包装食品标签通则",
    sub: "国家卫生健康委、国家市场监督管理总局 · 2025-03-16 发布 · 2027-03-16 实施（代替 GB 7718-2011）",
    links: [
      { label: "官方问答：GB 7718-2025（卫健委）", url: "https://www.nhc.gov.cn/sps/c100087/202509/bc824a504ec34c27883da73f14c20d44.shtml", src: true },
      { label: "下载 PDF 原件", url: "docs/gb7718-2025.pdf" },
    ],
    note: "",
    pdf: "docs/gb7718-2025.pdf",
  },
  {
    id: "gb28050",
    group: "GB 28050-2025 预包装食品营养标签通则",
    nav: "标准原文（PDF）",
    title: "GB 28050-2025 食品安全国家标准 预包装食品营养标签通则",
    sub: "国家卫生健康委、国家市场监督管理总局 · 2025-03-16 发布 · 2027-03-16 实施（代替 GB 28050-2011）",
    links: [
      { label: "官方问答：GB 28050-2025（卫健委）", url: "https://www.nhc.gov.cn/sps/c100087/202509/470fa4ff5de14dd38619223cce9da4e7.shtml", src: true },
      { label: "下载 PDF 原件", url: "docs/gb28050-2025.pdf" },
    ],
    note: "",
    pdf: "docs/gb28050-2025.pdf",
  },
  {
    id: "decree100",
    group: "部门规章",
    nav: "食品标识监督管理办法",
    title: "食品标识监督管理办法（国家市场监督管理总局令第 100 号）",
    sub: "2025-03-14 公布 · 2027-03-16 施行 · 国家市场监督管理总局（共 7 章 54 条）",
    links: [
      { label: "官方来源：司法部 部门规章库", url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202511/t20251106_527628.html", src: true },
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

// 句末终止标点（用于把 PDF 硬换行的续行重新拼回段落）
const TERM = /[。！？][”’）】》]?$/;

// 网站导航/页眉页脚噪声行（抓取自门户网站的问答类文档会带这些）
const JUNK_RE = /(https?:\/\/)|\(\/[a-zA-Z]|设为主页|收藏本站|返回主站|您现在所在位置|您的位置|浏览人次|^相关新闻$|^上一篇|^下一篇|^打印$|关闭窗口|Copyright|版权所有|版权声明|ICP备|联系地址|联系电话|^传真|公众科普网|扫一扫|分享到|网站地图|站点地图|^关于我们|^搜索$|新闻来源|食品安全国家标准数据检索平台|国家食品安全风险评估中心|^首页\s*[>＞]/;
// 门户栏目名（整行精确匹配才算噪声，避免误伤正文中的同名词）
const NAV_EXACT = new Set([
  "政策法规", "行业信息", "科技进展", "食品安全", "域外信息", "供应商推荐",
  "公开信息", "新闻中心", "学会介绍", "学会活动", "首页", "中文", "英文",
]);

// 识别噪声行：罗马页码、纯页码、重复的页眉（标准号 / “食品安全国家标准” / 标准名）、网站导航
function isNoise(t, info) {
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]+$/.test(t)) return true;
  if (/^\d{1,3}$/.test(t)) return true;
  if (info.num && t === info.num) return true;
  if (t === "食品安全国家标准") return true;
  if (info.titles.indexOf(t) >= 0) return true;
  if (NAV_EXACT.has(t)) return true;
  if (JUNK_RE.test(t)) return true;
  return false;
}

// 识别标题行，返回对应 HTML；非标题返回 null（标题须较短，避免把整段误判为标题）
function headingOf(t) {
  if (t.length > 32) return null;
  if (t === "前言" || t === "目次" || t === "目录") return `<div class="dh3">${esc(t)}</div>`;
  if (/^附\s*录\s*[A-ZＡ-Ｚ]/.test(t)) return `<div class="dh3">${esc(t)}</div>`;
  if (/^第[一二三四五六七八九十百零]+章/.test(t)) return `<div class="dh3">${esc(t)}</div>`;
  if (/^[一二三四五六七八九十]{1,2}\s*、/.test(t)) return `<div class="dh3">${esc(t.replace(/\s*、\s*/, "、"))}</div>`;
  if (/^（[一二三四五六七八九十]{1,3}）/.test(t)) return `<div class="dh4">${esc(t)}</div>`;
  if (/^\d{1,2}\s+\S/.test(t) && t.length <= 22) return `<div class="dh3">${esc(t)}</div>`;
  if (/^\d+\.\d+(\.\d+)*\s*\S/.test(t) && t.length <= 30) return `<div class="dh4">${esc(t)}</div>`;
  return null;
}

// 找封面块结束行号（仅当文档形如 GB 标准封面时）；无封面返回 0
function findCoverEnd(lines) {
  const head = lines.slice(0, 14).map((l) => l.trim());
  const looksCover = head.some((l) => /国家标准/.test(l)) && head.some((l) => /^GB\s/.test(l));
  if (!looksCover) return 0;
  for (let j = 0; j < Math.min(lines.length, 22); j++) {
    const t = lines[j].trim();
    if (t === "前言" || t === "目次" || t === "目录" || /^\d{1,2}\s+\S/.test(t)) return j;
    if (t === "发布" && j >= 4) return j + 1;
  }
  return 0;
}

function renderCover(cover, info) {
  let html = '<div class="doc-cover">';
  cover.forEach((l) => {
    if (/^GB\s/.test(l)) { info.num = l; html += `<div class="cv-num">${esc(l)}</div>`; }
    else if (l === "食品安全国家标准" || /国家标准$/.test(l)) { html += `<div class="cv-line">${esc(l)}</div>`; }
    else if (/通则|规范$|标准$|要求$/.test(l) && l.length <= 24 && !/发布|实施/.test(l)) {
      info.titles.push(l); html += `<div class="cv-title">${esc(l)}</div>`;
    } else { html += `<div class="cv-line">${esc(l)}</div>`; }
  });
  return html + "</div>";
}

// 纯文本（GB 标准 / 解读 / 问答）：居中封面 + 续行重排为段落 + 章节标题 + 列表，仿公文排版。
function renderTxt(text) {
  // 门户抓取的“解读材料”常把整篇挤成一行，章节标题（如“一 、 标准的修订原则”）夹在句中。
  // 这里在句末标点后、遇到带空格的中文序号顿号标题时断行，使其能被识别为章节。
  text = text.replace(/([。；！？”》])\s*(?=[一二三四五六七八九十]{1,2}\s+、\s*[\u4e00-\u9fff])/g, "$1\n");
  const lines = text.split("\n").map((l) => l.replace(/\s+$/g, ""));
  const out = [];
  const info = { num: "", titles: [] };
  let i = 0;
  const coverEnd = findCoverEnd(lines);
  if (coverEnd > 0) {
    out.push(renderCover(lines.slice(0, coverEnd).filter((l) => l.trim()), info));
    i = coverEnd;
  }
  let buf = "";
  const flush = () => { if (buf.trim()) out.push(`<p class="dp">${esc(buf.trim())}</p>`); buf = ""; };
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { flush(); continue; }
    if (isNoise(t, info)) continue;
    const h = headingOf(t);
    if (h) { flush(); out.push(h); continue; }
    if (/^(———|--+|·|•|●)/.test(t)) {
      flush();
      let item = t.replace(/^(———|--+|·|•|●)\s*/, "");
      while (i + 1 < lines.length) {
        const nx = lines[i + 1].trim();
        if (!nx || isNoise(nx, info) || headingOf(nx) || /^(———|--+|·|•|●)/.test(nx)) break;
        if (TERM.test(item) || /[；;]$/.test(item)) break;
        item += nx; i++;
      }
      out.push(`<ul class="dul"><li>${esc(item)}</li></ul>`);
      continue;
    }
    buf += t;
    if (TERM.test(t)) flush();
  }
  flush();
  // 合并相邻列表项为单个 ul，视觉更连贯
  return out.join("\n").replace(/<\/ul>\n<ul class="dul">/g, "");
}

// 轻量 Markdown（总局令）：## 章 / ### 节 / **加粗** / > 引用 / - 列表，段落首行缩进。
function renderMd(text) {
  const out = [];
  const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<span class="art">$1</span>');
  text.split("\n").forEach((line) => {
    const t = line.trim();
    if (!t) return;
    if (/^#\s+/.test(t)) return;
    if (/^##\s+/.test(t)) { out.push(`<div class="dh3">${esc(t.replace(/^##\s+/, ""))}</div>`); return; }
    if (/^###\s+/.test(t)) { out.push(`<div class="dh4">${esc(t.replace(/^###\s+/, ""))}</div>`); return; }
    if (/^>\s?/.test(t)) { out.push(`<div class="dquote">${bold(t.replace(/^>\s?/, ""))}</div>`); return; }
    if (/^[-*]\s+/.test(t)) { out.push(`<div class="dli2">${bold(t.replace(/^[-*]\s+/, ""))}</div>`); return; }
    out.push(`<p class="dp">${bold(t)}</p>`);
  });
  return out.join("\n");
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
    // 注意：页面设置了 <base href="/foodlabel/">，纯 "#id" 锚点会被解析到首页，
    // 必须带上 standards.html 才能停在本页（仅改变 hash → 触发 hashchange）。
    html += `<a class="nav-item" data-id="${d.id}" href="standards.html#${d.id}">${esc(d.nav)}</a>`;
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

// 渲染右侧单篇内容（仿官方公文版式：面包屑 + 居中标题 + 居中来源行 + 正文）
function renderDoc(doc) {
  const links = doc.links.map((l) =>
    `<a class="${l.src ? "src" : ""}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`
  ).join("");
  const note = doc.note ? `<p class="src-note">${esc(doc.note)}</p>` : "";
  const content = document.getElementById("docsContent");
  const body = doc.pdf
    ? `<iframe class="pdf-frame" src="${esc(doc.pdf)}#view=FitH" title="${esc(doc.title)}"></iframe>`
    : `<div class="doctext" id="docText">—</div>`;
  content.innerHTML =
    `<div class="doc-crumb">法规原文<span class="sep">›</span>${esc(doc.group)}</div>` +
    `<h1 class="doc-title">${esc(doc.title)}</h1>` +
    `<p class="doc-meta">${esc(doc.sub)}</p>` +
    `<div class="doc-links">${links}</div>` +
    note +
    body;
  if (!doc.pdf) loadText(doc, document.getElementById("docText"));
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

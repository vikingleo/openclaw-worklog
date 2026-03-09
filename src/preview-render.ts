import type { MonthDocument } from "./types.js";
import { fmtHours } from "./worklog-storage.js";

export function renderPreviewHtml(params: {
  title: string;
  senderId: string;
  bookKey: string;
  bookName: string;
  month: string;
  document: MonthDocument;
  rawPath: string;
  prevMonthPath: string;
  nextMonthPath: string;
  monthJumpPath: string;
  signedExp?: string;
  signedSig?: string;
}): string {
  const {
    title,
    senderId,
    bookKey,
    bookName,
    month,
    document,
    rawPath,
    prevMonthPath,
    nextMonthPath,
    monthJumpPath,
    signedExp,
    signedSig,
  } = params;
  const dayCount = document.sections.length;
  const itemCount = document.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const monthHours = document.sections.reduce(
    (sum, section) => sum + section.rows.reduce((rowSum, row) => rowSum + row.hours, 0),
    0,
  );
  const summaryBlock = document.summaryLine
    ? `<div class="summary-callout">${escapeHtml(document.summaryLine)}</div>`
    : "";
  const tocHtml = renderToc(document);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - ${escapeHtml(month)}</title>
<style>
:root {
  color-scheme: light;
  --page-bg: #f6f8fa;
  --panel-bg: #ffffff;
  --panel-muted: #f6f8fa;
  --border: #d0d7de;
  --border-muted: #e5e7eb;
  --text-primary: #24292f;
  --text-secondary: #57606a;
  --text-tertiary: #6e7781;
  --accent: #0969da;
  --accent-soft: #f0f7ff;
  --danger-soft: #ffebe9;
  --radius-lg: 12px;
  --radius-md: 10px;
  --radius-sm: 8px;
}
* { box-sizing: border-box; }
html {
  background: var(--page-bg);
  scroll-behavior: smooth;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
  background: var(--page-bg);
  color: var(--text-primary);
}
a { color: var(--accent); }
.container { max-width: 1040px; margin: 0 auto; padding: 24px 16px 40px; }
.hero {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px;
}
.eyebrow {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}
.hero-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.hero-copy { min-width: 0; }
.hero h1 { margin: 0; font-size: 30px; line-height: 1.25; }
.hero .lead { margin: 8px 0 0; font-size: 15px; color: var(--text-secondary); }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; }
.btn,
.btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-bg);
  color: var(--text-primary);
  text-decoration: none;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.btn-primary {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.meta-grid {
  margin: 16px 0 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.meta-item {
  padding: 12px 14px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--panel-bg);
}
.meta-item .label { margin: 0 0 6px; font-size: 12px; color: var(--text-tertiary); }
.meta-item .value { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.month-panel {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--panel-muted);
}
.month-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.month-panel-label { margin: 0 0 6px; font-size: 12px; color: var(--text-tertiary); }
.month-panel-value { margin: 0; font-size: 20px; font-weight: 700; }
.month-shortcuts { display: flex; flex-wrap: wrap; gap: 8px; }
.month-form {
  margin-top: 12px;
  display: flex;
  align-items: end;
  gap: 10px;
}
.month-form-field { flex: 1 1 220px; }
.month-form-label {
  display: block;
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}
.month-input {
  width: 100%;
  min-height: 38px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-bg);
  color: var(--text-primary);
}
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin: 14px 0;
}
.card {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 15px;
}
.card .label { font-size: 12px; color: var(--text-tertiary); margin-bottom: 8px; }
.card .value { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
.content-layout {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.layout-main { min-width: 0; }
.toc-floating {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 14px;
}
.toc-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.toc-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.toc-count {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}
.toc-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.toc-list li + li { margin-top: 4px; }
.toc-link {
  display: block;
  padding: 6px 8px;
  border-radius: 8px;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 13px;
  line-height: 1.4;
}
.toc-link:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.toc-link.overview {
  margin-bottom: 6px;
  font-weight: 600;
  color: var(--text-primary);
}
.content {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
}
.anchor-target,
.block { scroll-margin-top: 20px; }
.markdown-body {
  font-size: 16px;
  line-height: 1.75;
  color: var(--text-primary);
  word-wrap: break-word;
}
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body h2 {
  margin: 32px 0 12px;
  padding-bottom: 0.3em;
  font-size: 1.5em;
  line-height: 1.25;
  border-bottom: 1px solid var(--border-muted);
}
.markdown-body h3 {
  margin: 18px 0 10px;
  font-size: 1.05em;
  line-height: 1.4;
}
.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body blockquote,
.markdown-body table { margin-top: 0; margin-bottom: 16px; }
.summary-callout {
  margin-bottom: 24px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--panel-muted);
  color: var(--text-secondary);
}
.block + .block { margin-top: 32px; }
.meta { margin-bottom: 14px; font-size: 14px; color: var(--text-secondary); }
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  overflow: hidden;
}
th,
td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-muted);
  text-align: left;
  vertical-align: top;
  background: var(--panel-bg);
}
thead th {
  background: var(--panel-muted);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
tbody tr:nth-child(2n) td { background: #fbfcfd; }
th:last-child,
td:last-child { text-align: right; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
blockquote {
  margin: 16px 0 0;
  padding: 0 0 0 16px;
  color: var(--text-secondary);
  border-left: 4px solid var(--border);
}
.empty {
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  padding: 28px 18px;
  background: var(--panel-muted);
  color: var(--text-secondary);
  text-align: center;
}
.footer { margin-top: 14px; font-size: 13px; color: var(--text-tertiary); }
@media (min-width: 1200px) {
  .content-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 220px;
    align-items: start;
    gap: 16px;
  }
  .layout-main { order: 1; }
  .toc-floating {
    order: 2;
    position: sticky;
    top: 20px;
  }
}
@media (max-width: 719px) {
  .container { padding: 16px 12px 28px; }
  .hero,
  .content { padding: 16px; }
  .hero-main,
  .month-panel-header,
  .month-form { flex-direction: column; }
  .hero h1 { font-size: 26px; }
  .hero .lead,
  .markdown-body { font-size: 15px; }
  .meta-grid,
  .summary { gap: 8px; }
  .meta-item,
  .card,
  .summary-callout,
  .empty,
  .month-panel,
  .toc-floating { padding: 12px; }
  th,
  td { padding: 10px 12px; }
  .btn,
  .btn-primary,
  .month-form-field { width: 100%; }
  .month-shortcuts { width: 100%; }
}
</style>
</head>
<body>
<div class="container">
  <section class="hero">
    <p class="eyebrow">Worklog Preview</p>
    <div class="hero-main">
      <div class="hero-copy">
        <h1>${escapeHtml(title)}</h1>
        <p class="lead">${escapeHtml(document.title)}</p>
      </div>
      <div class="toolbar">
        <a class="btn" href="${escapeHtml(rawPath)}">下载原始 Markdown</a>
      </div>
    </div>
    <div class="meta-grid">
      <div class="meta-item"><p class="label">日志本</p><p class="value">${escapeHtml(bookName)}（${escapeHtml(bookKey)}）</p></div>
      <div class="meta-item"><p class="label">发送者</p><p class="value">${escapeHtml(senderId)}</p></div>
      <div class="meta-item"><p class="label">月份</p><p class="value">${escapeHtml(month)}</p></div>
      <div class="meta-item"><p class="label">文档标题</p><p class="value">${escapeHtml(document.title)}</p></div>
    </div>
    <section class="month-panel">
      <div class="month-panel-header">
        <div>
          <p class="month-panel-label">年月切换</p>
          <p class="month-panel-value">${escapeHtml(month)}</p>
        </div>
        <div class="month-shortcuts">
          <a class="btn" href="${escapeHtml(prevMonthPath)}">上个月</a>
          <a class="btn" href="${escapeHtml(nextMonthPath)}">下个月</a>
        </div>
      </div>
      <form class="month-form" method="post" action="${escapeHtml(monthJumpPath)}">
        <input type="hidden" name="senderId" value="${escapeHtml(senderId)}" />
        <input type="hidden" name="book" value="${escapeHtml(bookKey)}" />
        <input type="hidden" name="sourceMonth" value="${escapeHtml(month)}" />
        ${signedExp ? `<input type="hidden" name="exp" value="${escapeHtml(signedExp)}" />` : ""}
        ${signedSig ? `<input type="hidden" name="sig" value="${escapeHtml(signedSig)}" />` : ""}
        <div class="month-form-field">
          <label class="month-form-label" for="month-picker">选择年月</label>
          <input class="month-input" id="month-picker" name="month" type="month" value="${escapeHtml(month)}" required />
        </div>
        <button class="btn-primary" type="submit">跳转到该月</button>
      </form>
    </section>
  </section>

  <section class="summary">
    <div class="card"><div class="label">日期数：</div><div class="value">${dayCount}</div></div>
    <div class="card"><div class="label">工作项数：</div><div class="value">${itemCount}</div></div>
    <div class="card"><div class="label">累计工时：</div><div class="value">${escapeHtml(fmtHours(monthHours))}h</div></div>
  </section>

  <div class="content-layout">
    ${tocHtml}
    <div class="layout-main">
      <main id="month-overview" class="content markdown-body anchor-target">
        ${summaryBlock}
        ${document.sections.length ? document.sections.map((section) => renderSection(section)).join("\n") : '<section class="empty">当前月份还没有记录，空得很诚实。</section>'}
      </main>
      <div class="footer">预览只展示当前日志本的当月内容；非管理员必须先通过口令授权。</div>
    </div>
  </div>
</div>
</body>
</html>`;
}

export function renderAuthHtml(params: {
  title: string;
  senderId: string;
  month: string;
  book?: string;
  authPath: string;
  error?: string | null;
}): string {
  const { title, senderId, month, book, authPath, error } = params;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - 口令验证</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 20px;
  background: #f6f8fa;
  color: #24292f;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
}
.panel {
  width: min(92vw, 420px);
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 12px;
  padding: 22px;
}
.eyebrow {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6e7781;
}
h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.25; }
p { margin: 8px 0; color: #57606a; }
label { display: block; margin-top: 16px; margin-bottom: 8px; color: #24292f; font-size: 14px; font-weight: 600; }
input {
  width: 100%;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid #d0d7de;
  background: #ffffff;
  color: #24292f;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
input:focus {
  outline: none;
  border-color: #0969da;
  box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.12);
}
button {
  margin-top: 18px;
  width: 100%;
  min-height: 42px;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  background: #ffffff;
  color: #24292f;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}
.error {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #ff818266;
  background: #ffebe9;
  color: #cf222e;
}
</style>
</head>
<body>
  <form class="panel" method="post" action="${escapeHtml(authPath)}">
    <p class="eyebrow">Secure Access</p>
    <h1>${escapeHtml(title)}</h1>
    <p>发送者：${escapeHtml(senderId)}</p>
    <p>月份：${escapeHtml(month)}</p>
    ${book ? `<p>日志本：${escapeHtml(book)}</p>` : ""}
    <label for="password">浏览口令：</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <input type="hidden" name="senderId" value="${escapeHtml(senderId)}" />
    <input type="hidden" name="month" value="${escapeHtml(month)}" />
    <input type="hidden" name="book" value="${escapeHtml(book ?? "")}" />
    <button type="submit">进入预览</button>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  </form>
</body>
</html>`;
}

function renderSection(section: MonthDocument["sections"][number]): string {
  const dayHours = section.rows.reduce((sum, row) => sum + row.hours, 0);
  const anchor = buildSectionAnchor(section.day);
  return `<section id="${escapeHtml(anchor)}" class="block">
    <h2>${escapeHtml(section.day)}</h2>
    <div class="meta">总工时：${escapeHtml(fmtHours(dayHours))} 小时</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>工作项</th><th>工时（h）</th></tr>
        </thead>
        <tbody>
          ${section.rows.map((row, index) => `<tr><td>${escapeHtml(formatIndexedItem(row.item, index))}</td><td>${escapeHtml(fmtHours(row.hours))}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${section.comment ? `<h3>今日锐评</h3><blockquote>${escapeHtml(section.comment).replace(/\n/g, "<br />")}</blockquote>` : ""}
  </section>`;
}

function renderToc(document: MonthDocument): string {
  const overviewLink = '<li><a class="toc-link overview" href="#month-overview">月度概览</a></li>';
  const sectionLinks = document.sections.map((section) => {
    const anchor = buildSectionAnchor(section.day);
    return `<li><a class="toc-link" href="#${escapeHtml(anchor)}">${escapeHtml(section.day)}</a></li>`;
  }).join("");

  return `<aside class="toc-floating">
    <div class="toc-header">
      <p class="toc-title">目录</p>
      <p class="toc-count">${document.sections.length} 天</p>
    </div>
    <ul class="toc-list">
      ${overviewLink}
      ${sectionLinks}
    </ul>
  </aside>`;
}

function buildSectionAnchor(day: string): string {
  const normalized = day.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `day-${normalized || "section"}`;
}

function formatIndexedItem(item: string, index: number): string {
  return `${index + 1}. ${item}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

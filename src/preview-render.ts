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
  prevFilePath?: string;
  nextFilePath?: string;
  fileOptions: Array<{ label: string; path: string; current: boolean }>;
  monthJumpPath: string;
  shareActionPath?: string;
  shareUrl?: string;
  shareToken?: string;
  sharedView?: boolean;
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
    prevFilePath,
    nextFilePath,
    fileOptions,
    monthJumpPath,
    shareActionPath,
    shareUrl,
    shareToken,
    sharedView,
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
.nav-panel,
.share-panel {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--panel-bg);
}
.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.panel-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--panel-muted);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
}
.nav-actions,
.share-actions {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.picker-form { margin-top: 12px; display: flex; gap: 10px; align-items: end; }
.picker-field { flex: 1 1 240px; }
.picker-select,
.share-url {
  width: 100%;
  min-height: 38px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-bg);
  color: var(--text-primary);
}
.share-panel p,
.nav-panel p {
  margin: 10px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
}
.btn-danger {
  border-color: #cf222e;
  background: #ffebe9;
  color: #cf222e;
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
  max-height: min(60vh, 520px);
  overflow: auto;
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.16s ease, color 0.16s ease;
}
.toc-link:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.toc-link.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
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
  border-radius: var(--radius-md);
  background: var(--panel-bg);
}
table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--border);
}
th,
td {
  padding: 12px 14px;
  border: 1px solid var(--border-muted);
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
  .toc-floating,
  .nav-panel,
  .share-panel { padding: 12px; }
  th,
  td { padding: 10px 12px; }
  .btn,
  .btn-primary,
  .month-form-field,
  .picker-field { width: 100%; }
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
          <p class="month-panel-label">当前文件</p>
          <p class="month-panel-value">${escapeHtml(month)}</p>
        </div>
        <div class="month-shortcuts">
          ${prevFilePath ? `<a class="btn" href="${escapeHtml(prevFilePath)}">上一篇</a>` : ""}
          ${nextFilePath ? `<a class="btn" href="${escapeHtml(nextFilePath)}">下一篇</a>` : ""}
        </div>
      </div>
      <form class="month-form" method="post" action="${escapeHtml(monthJumpPath)}">
        <input type="hidden" name="senderId" value="${escapeHtml(senderId)}" />
        <input type="hidden" name="book" value="${escapeHtml(bookKey)}" />
        <input type="hidden" name="sourceMonth" value="${escapeHtml(month)}" />
        ${signedExp ? `<input type="hidden" name="exp" value="${escapeHtml(signedExp)}" />` : ""}
        ${signedSig ? `<input type="hidden" name="sig" value="${escapeHtml(signedSig)}" />` : ""}
        ${shareToken ? `<input type="hidden" name="share" value="${escapeHtml(shareToken)}" />` : ""}
        <div class="month-form-field">
          <label class="month-form-label" for="month-picker">选择年月</label>
          <input class="month-input" id="month-picker" name="month" type="month" value="${escapeHtml(month)}" required />
        </div>
        <button class="btn-primary" type="submit">按月份跳转</button>
      </form>
    </section>
    ${renderFileNavPanel(fileOptions)}
    ${renderSharePanel({
      shareActionPath,
      shareUrl,
      shareToken,
      sharedView: Boolean(sharedView),
      senderId,
      month,
      bookKey,
    })}
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
<script>
(() => {
  const tocLinks = Array.from(document.querySelectorAll('.toc-link[href^="#"]'));
  if (!tocLinks.length) return;
  const tocList = document.querySelector('.toc-list');
  const sections = tocLinks
    .map((link) => {
      const href = link.getAttribute('href') || '';
      const id = decodeURIComponent(href.slice(1));
      const section = document.getElementById(id);
      return section ? { link, section } : null;
    })
    .filter(Boolean);
  if (!sections.length) return;

  let activeId = "";

  const keepActiveVisible = (link) => {
    if (!tocList || !link) return;
    const listRect = tocList.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const topOffset = 10;
    const bottomOffset = 10;
    if (linkRect.top < listRect.top + topOffset) {
      tocList.scrollTop -= (listRect.top + topOffset - linkRect.top);
    } else if (linkRect.bottom > listRect.bottom - bottomOffset) {
      tocList.scrollTop += (linkRect.bottom - (listRect.bottom - bottomOffset));
    }
  };

  const setActive = (nextActiveId) => {
    let activeLink = null;
    for (const item of sections) {
      const isActive = item.section.id === nextActiveId;
      item.link.classList.toggle('active', isActive);
      if (isActive) activeLink = item.link;
    }
    if (nextActiveId !== activeId) {
      activeId = nextActiveId;
      keepActiveVisible(activeLink);
    }
  };

  const updateActive = () => {
    let nextActiveId = sections[0].section.id;
    for (const item of sections) {
      if (item.section.getBoundingClientRect().top <= 140) {
        nextActiveId = item.section.id;
      } else {
        break;
      }
    }
    setActive(nextActiveId);
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      updateActive();
      ticking = false;
    });
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('hashchange', updateActive);
  updateActive();

  document.querySelectorAll('[data-open-on-change]').forEach((select) => {
    select.addEventListener('change', () => {
      if (!(select instanceof HTMLSelectElement) || !select.value) return;
      window.location.href = select.value;
    });
  });

  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const targetId = button.getAttribute('data-copy-target');
      const input = targetId ? document.getElementById(targetId) : null;
      if (!(input instanceof HTMLInputElement)) return;
      try {
        await navigator.clipboard.writeText(input.value);
        button.textContent = '已复制';
        window.setTimeout(() => {
          button.textContent = '复制链接';
        }, 1200);
      } catch {
        input.focus();
        input.select();
      }
    });
  });
})();
</script>
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

export function renderLandingHtml(params: {
  title: string;
  previewPath: string;
  defaultMonth: string;
}): string {
  const { title, previewPath, defaultMonth } = params;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - 入口</title>
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
  width: min(94vw, 560px);
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
.tip {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid #d0d7de;
  border-radius: 10px;
  background: #f6f8fa;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 2px 6px;
}
label { display: block; margin-top: 16px; margin-bottom: 8px; color: #24292f; font-size: 14px; font-weight: 600; }
input {
  width: 100%;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid #d0d7de;
  background: #ffffff;
  color: #24292f;
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
ul {
  margin: 10px 0 0;
  padding-left: 20px;
  color: #57606a;
}
li + li { margin-top: 6px; }
</style>
</head>
<body>
  <form class="panel" method="get" action="${escapeHtml(previewPath)}">
    <p class="eyebrow">Preview Entry</p>
    <h1>${escapeHtml(title)}</h1>
    <p>根路径不是预览正文页。要进入工作日志预览，至少需要 <span class="code">senderId</span> 和 <span class="code">month</span> 两个参数。</p>
    <div class="tip">
      <strong>senderId 格式示例</strong>
      <ul>
        <li>VoceChat: <span class="code">vocechat:user:1</span></li>
        <li>Telegram: <span class="code">telegram:6684352915</span></li>
      </ul>
    </div>
    <label for="senderId">senderId</label>
    <input id="senderId" name="senderId" type="text" placeholder="vocechat:user:1" required />
    <label for="month">month</label>
    <input id="month" name="month" type="text" value="${escapeHtml(defaultMonth)}" pattern="\\d{4}-\\d{2}" required />
    <label for="book">book（可选）</label>
    <input id="book" name="book" type="text" placeholder="u-telegram-6684352915" />
    <button type="submit">进入预览</button>
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

function renderFileNavPanel(fileOptions: Array<{ label: string; path: string; current: boolean }>): string {
  return `<section class="nav-panel">
    <div class="panel-header">
      <h2 class="panel-title">同目录文件</h2>
      <span class="panel-badge">${fileOptions.length} 个</span>
    </div>
    <p>按文件顺序快速切换到上一篇、下一篇，或直接选择当前目录中的其他日志文件。</p>
    <form class="picker-form" onsubmit="return false;">
      <div class="picker-field">
        <label class="month-form-label" for="file-picker">快速打开</label>
        <select id="file-picker" class="picker-select" data-open-on-change>
          ${fileOptions.map((item) => `<option value="${escapeHtml(item.path)}"${item.current ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
        </select>
      </div>
    </form>
  </section>`;
}

function renderSharePanel(params: {
  shareActionPath?: string;
  shareUrl?: string;
  shareToken?: string;
  sharedView: boolean;
  senderId: string;
  month: string;
  bookKey: string;
}): string {
  const {
    shareActionPath,
    shareUrl,
    shareToken,
    sharedView,
    senderId,
    month,
    bookKey,
  } = params;

  if (sharedView) {
    return `<section class="share-panel">
      <div class="panel-header">
        <h2 class="panel-title">分享状态</h2>
        <span class="panel-badge">分享访问</span>
      </div>
      <p>当前页面通过分享链接打开，原持有人关闭分享后，这条链接会立即失效。</p>
    </section>`;
  }

  if (!shareActionPath) {
    return "";
  }

  if (shareUrl) {
    return `<section class="share-panel">
      <div class="panel-header">
        <h2 class="panel-title">分享状态</h2>
        <span class="panel-badge">已开启</span>
      </div>
      <p>这条链接长期有效，直到你手动关闭。关闭后旧链接会立即失效。</p>
      <input id="share-url-input" class="share-url" type="text" readonly value="${escapeHtml(shareUrl)}" />
      <div class="share-actions">
        <button class="btn" type="button" data-copy-target="share-url-input">复制链接</button>
        <form method="post" action="${escapeHtml(shareActionPath)}">
          <input type="hidden" name="action" value="close" />
          <input type="hidden" name="senderId" value="${escapeHtml(senderId)}" />
          <input type="hidden" name="month" value="${escapeHtml(month)}" />
          <input type="hidden" name="book" value="${escapeHtml(bookKey)}" />
          ${shareToken ? `<input type="hidden" name="share" value="${escapeHtml(shareToken)}" />` : ""}
          <button class="btn btn-danger" type="submit">关闭分享</button>
        </form>
      </div>
    </section>`;
  }

  return `<section class="share-panel">
    <div class="panel-header">
      <h2 class="panel-title">分享状态</h2>
      <span class="panel-badge">未开启</span>
    </div>
    <p>开启后会生成一条长期有效的预览链接，任何拿到链接的人都可以直接查看当前日志本。</p>
    <div class="share-actions">
      <form method="post" action="${escapeHtml(shareActionPath)}">
        <input type="hidden" name="action" value="open" />
        <input type="hidden" name="senderId" value="${escapeHtml(senderId)}" />
        <input type="hidden" name="month" value="${escapeHtml(month)}" />
        <input type="hidden" name="book" value="${escapeHtml(bookKey)}" />
        <button class="btn-primary" type="submit">开启分享</button>
      </form>
    </div>
  </section>`;
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

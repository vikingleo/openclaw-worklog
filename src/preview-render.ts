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
}): string {
  const { title, senderId, bookKey, bookName, month, document, rawPath } = params;
  const dayCount = document.sections.length;
  const itemCount = document.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const monthHours = document.sections.reduce(
    (sum, section) => sum + section.rows.reduce((rowSum, row) => rowSum + row.hours, 0),
    0,
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - ${escapeHtml(month)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b1020; color: #edf2ff; }
.container { max-width: 1080px; margin: 0 auto; padding: 24px 20px 48px; }
.hero { background: linear-gradient(135deg, #172554, #1d4ed8); border-radius: 20px; padding: 24px; box-shadow: 0 16px 40px rgba(0,0,0,0.25); }
.hero h1 { margin: 0 0 10px; font-size: 28px; }
.hero p { margin: 6px 0; color: #dbeafe; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 18px 0 28px; }
.card { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 14px 16px; }
.card .label { font-size: 13px; color: #bfdbfe; margin-bottom: 8px; }
.card .value { font-size: 22px; font-weight: 700; }
.block { background: #111827; border: 1px solid #1f2937; border-radius: 18px; padding: 18px; margin-top: 18px; }
.block h2 { margin: 0 0 10px; font-size: 20px; }
.meta { color: #93c5fd; font-size: 14px; margin-bottom: 14px; }
table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 12px; }
th, td { padding: 12px 14px; border-bottom: 1px solid #243042; text-align: left; vertical-align: top; }
th:last-child, td:last-child { text-align: right; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
blockquote { margin: 14px 0 0; padding: 12px 14px; background: #0f172a; border-left: 4px solid #60a5fa; color: #e5edff; border-radius: 10px; }
a { color: #93c5fd; }
.toolbar { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 12px; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 14px; border-radius: 999px; background: #2563eb; color: white; text-decoration: none; font-weight: 600; }
.empty { background: #111827; border: 1px dashed #334155; border-radius: 18px; padding: 32px 20px; color: #cbd5e1; margin-top: 18px; }
.footer { margin-top: 24px; font-size: 13px; color: #94a3b8; }
</style>
</head>
<body>
<div class="container">
  <section class="hero">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(document.title)}</p>
    <p>日志本：${escapeHtml(bookName)}（${escapeHtml(bookKey)}）</p>
    <p>发送者：${escapeHtml(senderId)}</p>
    <p>月份：${escapeHtml(month)}</p>
    ${document.summaryLine ? `<p>${escapeHtml(document.summaryLine)}</p>` : ""}
    <div class="toolbar">
      <a class="btn" href="${escapeHtml(rawPath)}">下载原始 Markdown</a>
    </div>
  </section>

  <section class="summary">
    <div class="card"><div class="label">日期数：</div><div class="value">${dayCount}</div></div>
    <div class="card"><div class="label">工作项数：</div><div class="value">${itemCount}</div></div>
    <div class="card"><div class="label">累计工时：</div><div class="value">${escapeHtml(fmtHours(monthHours))}h</div></div>
  </section>

  ${document.sections.length ? document.sections.map((section) => renderSection(section)).join("\n") : '<section class="empty">当前月份还没有记录，空得很诚实。</section>'}

  <div class="footer">预览只展示当前日志本的当月内容；非管理员必须先通过口令授权。</div>
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
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.panel { width: min(92vw, 420px); background: #111827; border: 1px solid #1f2937; border-radius: 18px; padding: 24px; box-shadow: 0 16px 40px rgba(0,0,0,0.25); }
h1 { margin: 0 0 10px; font-size: 24px; }
p { margin: 8px 0; color: #cbd5e1; }
label { display: block; margin-top: 14px; margin-bottom: 8px; color: #bfdbfe; font-size: 14px; }
input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid #334155; background: #020617; color: #f8fafc; }
button { margin-top: 18px; width: 100%; min-height: 44px; border: 0; border-radius: 12px; background: #2563eb; color: white; font-size: 15px; font-weight: 700; cursor: pointer; }
.error { margin-top: 12px; padding: 10px 12px; border-radius: 12px; background: rgba(220, 38, 38, 0.15); color: #fecaca; }
</style>
</head>
<body>
  <form class="panel" method="post" action="${escapeHtml(authPath)}">
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
  return `<section class="block">
    <h2>${escapeHtml(section.day)}</h2>
    <div class="meta">总工时：${escapeHtml(fmtHours(dayHours))} 小时</div>
    <table>
      <thead>
        <tr><th>工作项</th><th>工时（h）</th></tr>
      </thead>
      <tbody>
        ${section.rows.map((row) => `<tr><td>${escapeHtml(row.item)}</td><td>${escapeHtml(fmtHours(row.hours))}</td></tr>`).join("")}
      </tbody>
    </table>
    ${section.comment ? `<blockquote>${escapeHtml(section.comment).replace(/\n/g, "<br />")}</blockquote>` : ""}
  </section>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

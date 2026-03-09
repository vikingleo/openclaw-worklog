import fs from "node:fs";
import path from "node:path";

import type { DaySection, MonthDocument, RuntimeConfig, WorklogRow } from "./types.js";

const DAY_HEADER_RE = /^##\s+(\d{4}-\d{2}-\d{2})（总工时：([0-9]+(?:\.[0-9]+)?)小时）\s*$/;
const ROW_RE = /^\|\s*(.+?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*$/;
const ITEM_NUMBER_RE = /^\d+\.\s*/;

export function appendWorklogEntry(params: {
  config: RuntimeConfig;
  bookPath: string;
  day: string;
  item: string;
  hours: number;
}): Record<string, unknown> {
  const { config, bookPath, day, item, hours } = params;
  const month = day.slice(0, 7);
  const monthFile = path.join(bookPath, `${month}.md`);
  fs.mkdirSync(path.dirname(monthFile), { recursive: true });

  let lines = ensureBaseFile(monthFile, month, config.monthlyTargetHours);
  const sections = parseSections(lines, config.commentPolicy.title);
  const target = sections.find((section) => section.day === day) ?? null;

  let status = "added";
  if (!target) {
    const block = buildDayBlock(day, [{ item, hours }], null, config.commentPolicy.title);
    if (lines.length && lines[lines.length - 1].trim()) {
      lines.push("");
    }
    lines.push(...block);
  } else {
    const normalizedItems = new Set(target.rows.map((row) => normalizeItem(row.item)));
    const nextRows = [...target.rows];
    if (normalizedItems.has(normalizeItem(item))) {
      status = "skipped";
    } else {
      nextRows.push({ item, hours });
    }
    const block = buildDayBlock(day, nextRows, target.comment, config.commentPolicy.title);
    lines = [...lines.slice(0, target.start), ...block, ...lines.slice(target.end)];
  }

  return writeMonthFile({ config, monthFile, lines, day, bookPath, status });
}

export function replaceWorklogEntry(params: {
  config: RuntimeConfig;
  bookPath: string;
  day: string;
  rowIndex: number;
  item: string;
  hours: number;
}): Record<string, unknown> {
  const { config, bookPath, day, rowIndex, item, hours } = params;
  const month = day.slice(0, 7);
  const monthFile = path.join(bookPath, `${month}.md`);
  if (!fs.existsSync(monthFile)) {
    throw new Error(`当月日志不存在：${month}`);
  }

  const lines = trimTrailingEmptyLines(fs.readFileSync(monthFile, "utf8").split(/\r?\n/));
  const sections = parseSections(lines, config.commentPolicy.title);
  const target = sections.find((section) => section.day === day);
  if (!target) {
    throw new Error(`指定日期不存在：${day}`);
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > target.rows.length) {
    throw new Error(`记录序号不存在：${rowIndex}`);
  }

  const nextRows = [...target.rows];
  nextRows[rowIndex - 1] = { item, hours };
  const block = buildDayBlock(day, nextRows, target.comment, config.commentPolicy.title);
  const nextLines = [...lines.slice(0, target.start), ...block, ...lines.slice(target.end)];
  return writeMonthFile({ config, monthFile, lines: nextLines, day, bookPath, status: "updated" });
}

export function deleteWorklogEntries(params: {
  config: RuntimeConfig;
  bookPath: string;
  day: string;
  rowIndices: number[];
}): Record<string, unknown> {
  const { config, bookPath, day, rowIndices } = params;
  const month = day.slice(0, 7);
  const monthFile = path.join(bookPath, `${month}.md`);
  if (!fs.existsSync(monthFile)) {
    throw new Error(`当月日志不存在：${month}`);
  }

  const uniqueIndices = Array.from(new Set(rowIndices)).sort((a, b) => a - b);
  if (!uniqueIndices.length) {
    throw new Error("批量删除至少需要一条记录序号。");
  }

  const lines = trimTrailingEmptyLines(fs.readFileSync(monthFile, "utf8").split(/\r?\n/));
  const sections = parseSections(lines, config.commentPolicy.title);
  const target = sections.find((section) => section.day === day);
  if (!target) {
    throw new Error(`指定日期不存在：${day}`);
  }

  for (const rowIndex of uniqueIndices) {
    if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > target.rows.length) {
      throw new Error(`记录序号不存在：${rowIndex}`);
    }
  }

  const indexSet = new Set(uniqueIndices.map((index) => index - 1));
  const nextRows = target.rows.filter((_, index) => !indexSet.has(index));
  let nextLines: string[];
  if (nextRows.length > 0) {
    const block = buildDayBlock(day, nextRows, target.comment, config.commentPolicy.title);
    nextLines = [...lines.slice(0, target.start), ...block, ...lines.slice(target.end)];
  } else {
    nextLines = compactRemovedSection([...lines.slice(0, target.start), ...lines.slice(target.end)]);
  }

  return writeMonthFile({ config, monthFile, lines: nextLines, day, bookPath, status: "deleted-batch" });
}

export function deleteWorklogEntry(params: {
  config: RuntimeConfig;
  bookPath: string;
  day: string;
  rowIndex: number;
}): Record<string, unknown> {
  const { config, bookPath, day, rowIndex } = params;
  const month = day.slice(0, 7);
  const monthFile = path.join(bookPath, `${month}.md`);
  if (!fs.existsSync(monthFile)) {
    throw new Error(`当月日志不存在：${month}`);
  }

  const lines = trimTrailingEmptyLines(fs.readFileSync(monthFile, "utf8").split(/\r?\n/));
  const sections = parseSections(lines, config.commentPolicy.title);
  const target = sections.find((section) => section.day === day);
  if (!target) {
    throw new Error(`指定日期不存在：${day}`);
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > target.rows.length) {
    throw new Error(`记录序号不存在：${rowIndex}`);
  }

  const nextRows = target.rows.filter((_, index) => index !== rowIndex - 1);
  let nextLines: string[];
  if (nextRows.length > 0) {
    const block = buildDayBlock(day, nextRows, target.comment, config.commentPolicy.title);
    nextLines = [...lines.slice(0, target.start), ...block, ...lines.slice(target.end)];
  } else {
    nextLines = compactRemovedSection([...lines.slice(0, target.start), ...lines.slice(target.end)]);
  }

  return writeMonthFile({ config, monthFile, lines: nextLines, day, bookPath, status: "deleted" });
}

export function upsertDayComment(params: {
  config: RuntimeConfig;
  bookPath: string;
  day: string;
  comment: string;
}): Record<string, unknown> {
  const { config, bookPath, day, comment } = params;
  const month = day.slice(0, 7);
  const monthFile = path.join(bookPath, `${month}.md`);
  if (!fs.existsSync(monthFile)) {
    throw new Error(`当月日志不存在：${month}`);
  }

  const lines = trimTrailingEmptyLines(fs.readFileSync(monthFile, "utf8").split(/\r?\n/));
  const sections = parseSections(lines, config.commentPolicy.title);
  const target = sections.find((section) => section.day === day);
  if (!target) {
    throw new Error(`指定日期不存在：${day}`);
  }

  const block = buildDayBlock(day, target.rows, comment, config.commentPolicy.title);
  const nextLines = [...lines.slice(0, target.start), ...block, ...lines.slice(target.end)];
  return writeMonthFile({ config, monthFile, lines: nextLines, day, bookPath, status: "commented" });
}

export function locateMonthFile(bookPath: string, month: string): { file: string; exists: boolean } {
  const file = path.join(bookPath, `${month}.md`);
  return { file, exists: fs.existsSync(file) };
}

export function loadMonthDocument(params: {
  config: RuntimeConfig;
  bookPath: string;
  month: string;
}): MonthDocument {
  const { config, bookPath, month } = params;
  const file = path.join(bookPath, `${month}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`当月日志不存在：${month}`);
  }

  const rawContent = fs.readFileSync(file, "utf8");
  const lines = trimTrailingEmptyLines(rawContent.split(/\r?\n/));
  const title = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "") ?? `${month} 工作日志`;
  const summaryLine = lines.find((line) => line.startsWith("> 本月工时：")) ?? null;

  return {
    month,
    file,
    title,
    summaryLine,
    sections: parseSections(lines, config.commentPolicy.title),
    rawContent,
  };
}

export function parseSections(lines: string[], commentTitle: string): DaySection[] {
  const headers: Array<{ line: number; day: string }> = [];
  for (const [index, line] of lines.entries()) {
    const match = DAY_HEADER_RE.exec(line.trim());
    if (match) {
      headers.push({ line: index, day: match[1] });
    }
  }

  return headers.map((header, index) => {
    const end = headers[index + 1]?.line ?? lines.length;
    const sectionLines = lines.slice(header.line + 1, end);
    const rows: WorklogRow[] = [];
    let comment: string | null = null;

    const commentTitleIndex = sectionLines.findIndex((line) => line.trim() === `### ${commentTitle}`);
    const rowLimit = commentTitleIndex >= 0 ? commentTitleIndex : sectionLines.length;
    for (const raw of sectionLines.slice(0, rowLimit)) {
      const match = ROW_RE.exec(raw.trim());
      if (!match) {
        continue;
      }
      rows.push({
        item: stripItemNumber(match[1]),
        hours: Number.parseFloat(match[2]),
      });
    }

    if (commentTitleIndex >= 0) {
      const commentLines = sectionLines
        .slice(commentTitleIndex + 1)
        .map((line) => line.trim())
        .filter((line) => Boolean(line))
        .map((line) => line.startsWith(">") ? line.replace(/^>\s?/, "") : line);
      comment = commentLines.join("\n").trim() || null;
    }

    return {
      day: header.day,
      start: header.line,
      end,
      rows,
      comment,
    };
  });
}

export function fmtHours(value: number): string {
  if (Math.abs(value - Math.round(value)) < 1e-9) {
    return String(Math.round(value));
  }
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function writeMonthFile(params: {
  config: RuntimeConfig;
  monthFile: string;
  lines: string[];
  day: string;
  bookPath: string;
  status: string;
}): Record<string, unknown> {
  const { config, monthFile, day, bookPath, status } = params;
  let lines = trimTrailingEmptyLines(params.lines);
  const sections = parseSections(lines, config.commentPolicy.title);
  const monthTotal = sections.reduce(
    (sum, section) => sum + section.rows.reduce((rowSum, row) => rowSum + row.hours, 0),
    0,
  );
  const ratio = config.monthlyTargetHours > 0 ? (monthTotal / config.monthlyTargetHours) * 100 : 0;
  const summaryLine = `> 本月工时：${fmtHours(monthTotal)}h / ${fmtHours(config.monthlyTargetHours)}h（目标工时），消耗占比：${ratio.toFixed(2)}%`;

  const summaryIndex = lines.findIndex((line) => line.startsWith("> 本月工时："));
  if (summaryIndex >= 0) {
    lines[summaryIndex] = summaryLine;
  } else if (lines[0]?.startsWith("# ")) {
    lines.splice(1, 0, summaryLine);
  } else {
    lines.unshift(summaryLine);
  }

  fs.writeFileSync(monthFile, `${trimTrailingEmptyLines(lines).join("\n")}\n`, "utf8");

  const finalSections = parseSections(trimTrailingEmptyLines(lines), config.commentPolicy.title);
  const daySection = finalSections.find((section) => section.day === day);
  const dayTotal = daySection?.rows.reduce((sum, row) => sum + row.hours, 0) ?? 0;
  const dayItemCount = daySection?.rows.length ?? 0;

  return {
    status,
    bookPath,
    file: monthFile,
    day,
    dayTotalHours: Number(dayTotal.toFixed(4)),
    dayItemCount,
    monthTotalHours: Number(monthTotal.toFixed(4)),
    monthRatioPercent: Number(ratio.toFixed(2)),
  };
}

function buildDayBlock(day: string, rows: WorklogRow[], comment: string | null, commentTitle: string): string[] {
  const dayTotal = rows.reduce((sum, row) => sum + row.hours, 0);
  const output = [
    `## ${day}（总工时：${fmtHours(dayTotal)}小时）`,
    "| 工作项 | 工时（h） |",
    "|---|---:|",
  ];

  rows.forEach((row, index) => {
    output.push(`| ${index + 1}. ${row.item} | ${fmtHours(row.hours)} |`);
  });

  if (comment) {
    output.push("", `### ${commentTitle}`, "");
    for (const line of comment.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      output.push(`> ${line}`);
    }
  }

  return output;
}

function ensureBaseFile(monthFile: string, month: string, monthlyTargetHours: number): string[] {
  if (fs.existsSync(monthFile)) {
    return trimTrailingEmptyLines(fs.readFileSync(monthFile, "utf8").split(/\r?\n/));
  }
  return [
    `# ${month} 工作日志`,
    `> 本月工时：0h / ${fmtHours(monthlyTargetHours)}h（目标工时），消耗占比：0.00%`,
    "",
  ];
}

function compactRemovedSection(lines: string[]): string[] {
  const next = [...lines];
  for (let index = next.length - 1; index > 0; index -= 1) {
    if (!next[index].trim() && !next[index - 1].trim()) {
      next.splice(index, 1);
    }
  }
  return trimTrailingEmptyLines(next);
}

function normalizeItem(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function stripItemNumber(text: string): string {
  return text.replace(ITEM_NUMBER_RE, "").trim();
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const cloned = [...lines];
  while (cloned.length && !cloned[cloned.length - 1].trim()) {
    cloned.pop();
  }
  return cloned;
}

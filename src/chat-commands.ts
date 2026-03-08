import { adminSenderSet, authorizeViewerSession, checkReadAccess, getBoundBookForSender, locateBookPath, resolveBook } from "./access.js";
import { buildRuntimeConfigFromPlugin } from "./config.js";
import { enforceReadScope, enforceWriteScope, validateWorkItem } from "./guards.js";
import {
  clearInputState,
  getEffectiveBooks,
  getInputState,
  loadState,
  purgeExpiredInputStates,
  saveState,
  setInputState,
} from "./state-store.js";
import type {
  LoggerLike,
  RuntimeConfig,
  RuntimeState,
  WorklogInputState,
} from "./types.js";
import type {
  OpenClawPluginApi,
  PluginCommandContext,
  ReplyPayload,
  TelegramInlineKeyboardButton,
} from "openclaw/plugin-sdk";
import { appendWorklogEntry, fmtHours, loadMonthDocument } from "./worklog-storage.js";

const WORKLOG_COMMAND = "worklog";
const WORKLOG_CN_COMMAND = "工作日志";
const INPUT_STATE_TTL_MS = 30 * 60 * 1000;

type WorklogAction =
  | { kind: "menu" }
  | { kind: "today" }
  | { kind: "month" }
  | { kind: "recent" }
  | { kind: "books" }
  | { kind: "help" }
  | { kind: "add" }
  | { kind: "direct-input" }
  | { kind: "hours-only" }
  | { kind: "preset-hours"; hours: number }
  | { kind: "submit-preset-item"; item: string }
  | { kind: "append"; hours: number; item: string }
  | { kind: "use-book"; book: string }
  | { kind: "auth"; password: string }
  | { kind: "cancel" }
  | { kind: "invalid"; message: string };

export function registerWorklogChatCommands(api: OpenClawPluginApi): void {
  const handler = async (ctx: PluginCommandContext) => await handleWorklogCommand(ctx, api);

  api.registerCommand({
    name: WORKLOG_COMMAND,
    description: "工作日志 Telegram 卡片与命令入口",
    acceptsArgs: true,
    requireAuth: true,
    handler,
  });

  api.registerCommand({
    name: WORKLOG_CN_COMMAND,
    description: "工作日志 Telegram 卡片与命令入口（中文别名）",
    acceptsArgs: true,
    requireAuth: true,
    handler,
  });
}

async function handleWorklogCommand(ctx: PluginCommandContext, api: OpenClawPluginApi): Promise<ReplyPayload> {
  const config = buildRuntimeConfigFromPlugin({
    openclawConfig: api.config as Record<string, unknown>,
    pluginConfig: api.pluginConfig,
  });
  const senderId = normalizeSenderId(ctx);
  if (!senderId) {
    return replyText("工作日志\n\n缺少发送者标识，无法定位日志本。", true);
  }

  const action = parseWorklogAction(ctx.args ?? "");
  try {
    switch (action.kind) {
      case "menu":
        return renderMenu(config, senderId, ctx.channel);
      case "today":
        return renderToday(config, senderId, ctx.channel);
      case "month":
        return renderMonth(config, senderId, ctx.channel);
      case "recent":
        return renderRecent(config, senderId, ctx.channel);
      case "books":
        return renderBooks(config, senderId, ctx.channel);
      case "help":
        return renderHelp(config, senderId, ctx.channel);
      case "add":
        return renderAddEntry(config, senderId, ctx.channel);
      case "direct-input":
        return renderDirectInput(config, senderId, ctx.channel);
      case "hours-only":
        return renderHoursOnly(config, senderId, ctx.channel);
      case "preset-hours":
        return renderPresetHoursPicked(config, senderId, action.hours, ctx.channel);
      case "submit-preset-item":
        return handlePresetItemSubmit(config, senderId, action.item, ctx.channel, api.logger);
      case "append":
        return handleAppend(config, senderId, action.hours, action.item, ctx.channel, api.logger);
      case "use-book":
        return handleUseBook(config, senderId, action.book, ctx.channel);
      case "auth":
        return handleAuth(config, senderId, action.password, ctx.channel);
      case "cancel":
        return handleCancel(config, senderId, ctx.channel);
      case "invalid":
        return renderInvalid(config, senderId, action.message, ctx.channel);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.warn(`[worklog] command failed sender=${senderId} err=${message}`);
    return replyText(`工作日志\n\n${message}`, true);
  }
}

function parseWorklogAction(rawArgs: string): WorklogAction {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { kind: "menu" };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const head = tokens[0]?.toLowerCase() ?? "";
  const rest = trimmed.slice(tokens[0]?.length ?? 0).trim();

  if (["m", "menu", "home"].includes(head)) return { kind: "menu" };
  if (["t", "today"].includes(head)) return { kind: "today" };
  if (["s", "stat", "stats", "month", "monthly"].includes(head)) return { kind: "month" };
  if (["r", "recent", "week"].includes(head)) return { kind: "recent" };
  if (["b", "book", "books"].includes(head)) return { kind: "books" };
  if (["h", "help"].includes(head)) return { kind: "help" };
  if (["a", "add"].includes(head)) return { kind: "add" };
  if (["ai", "input"].includes(head)) return { kind: "direct-input" };
  if (["ah", "hours"].includes(head)) return { kind: "hours-only" };
  if (["x", "cancel"].includes(head)) return { kind: "cancel" };

  if (head === "ph") {
    const hours = Number.parseFloat(tokens[1] ?? "");
    if (!Number.isFinite(hours) || hours <= 0) {
      return { kind: "invalid", message: "工时按钮参数无效。" };
    }
    return { kind: "preset-hours", hours };
  }

  if (["item", "i"].includes(head)) {
    const payload = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!payload) {
      return { kind: "invalid", message: "请输入工作项内容，例如：/worklog item 修复筛选回显" };
    }
    return { kind: "submit-preset-item", item: payload };
  }

  if (head === "auth") {
    const password = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!password) {
      return { kind: "invalid", message: "请提供口令，例如：/worklog auth 你的口令" };
    }
    return { kind: "auth", password };
  }

  if (head === "use") {
    const book = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!book) {
      return { kind: "invalid", message: "请提供日志本 key，例如：/worklog use demo" };
    }
    return { kind: "use-book", book };
  }

  if (["append", "log"].includes(head)) {
    const payload = trimmed.replace(/^\S+\s*/u, "").trim();
    const parsed = parseAppendPayload(payload);
    return parsed ?? {
      kind: "invalid",
      message: "写入格式不对。请用：/worklog append 1.5 修复筛选回显",
    };
  }

  const shorthand = parseAppendPayload(trimmed);
  if (shorthand) {
    return shorthand;
  }

  return {
    kind: "invalid",
    message: "无法识别指令。可用：/worklog、/worklog today、/worklog month、/worklog append 1.5 修复筛选回显",
  };
}

function parseAppendPayload(raw: string): Extract<WorklogAction, { kind: "append" }> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s+(.*)$/u);
  if (!match) {
    return null;
  }

  const hours = Number.parseFloat(match[1]);
  const item = match[2]?.trim() ?? "";
  if (!Number.isFinite(hours) || hours <= 0 || !item) {
    return null;
  }

  return { kind: "append", hours, item };
}

function renderMenu(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  if (changed) {
    saveStateIfChanged(config, state);
  }
  const currentInput = getInputState(state, channel, senderId);
  const bookSummary = formatBookSummary(config, state, senderId);
  const lines = [
    "工作日志",
    "",
    `当前日志本：${bookSummary}`,
    currentInput ? `输入状态：${formatInputState(currentInput)}` : "输入状态：空闲",
    "",
    "请选择操作：",
  ];

  if (channel === "telegram") {
    return replyWithButtons(lines.join("\n"), buildMenuButtons());
  }

  lines.push(
    "- /worklog add",
    "- /worklog today",
    "- /worklog month",
    "- /worklog recent",
    "- /worklog books",
    "- /worklog help",
  );
  return replyText(lines.join("\n"));
}

function renderAddEntry(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  const lines = [
    "记录工作日志",
    "",
    "可选两种方式：",
    "1. 直接输入：/worklog 1.5 修复筛选回显",
    "2. 先选工时，再发：/worklog item 修复筛选回显",
    "",
    "点击下方按钮继续。",
  ];

  if (channel === "telegram") {
    return replyWithButtons(lines.join("\n"), [
      [button("📝 直接输入内容", `/${WORKLOG_COMMAND} ai`)],
      [button("⏱ 只填工时", `/${WORKLOG_COMMAND} ah`)],
      [button("⬅️ 返回主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }

  return replyText(lines.join("\n"));
}

function renderDirectInput(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  const lines = [
    "记录工作日志",
    "",
    "请直接发送以下格式：",
    `/worklog 1.5 修复筛选回显`,
    `/worklog append 2 联调 Telegram 卡片`,
    "",
    "写入后我会回显今日和本月汇总。",
  ];

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
    [button("⬅️ 返回主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderHoursOnly(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  const lines = [
    "选择工时",
    "",
    "先点一个常用工时，随后发送：",
    `/worklog item 修复筛选回显`,
    "",
    "如果想一次写完，也可以直接用 /worklog 1.5 修复筛选回显。",
  ];

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("0.5h", `/${WORKLOG_COMMAND} ph 0.5`), button("1h", `/${WORKLOG_COMMAND} ph 1`), button("2h", `/${WORKLOG_COMMAND} ph 2`)],
    [button("3h", `/${WORKLOG_COMMAND} ph 3`), button("4h", `/${WORKLOG_COMMAND} ph 4`)],
    [button("❌ 取消", `/${WORKLOG_COMMAND} x`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderPresetHoursPicked(config: RuntimeConfig, senderId: string, hours: number, channel: string): ReplyPayload {
  const state = loadState(config);
  setInputState(state, channel, senderId, {
    mode: "awaiting_item_for_hours",
    presetHours: hours,
    createdAt: Date.now(),
    expiresAt: Date.now() + INPUT_STATE_TTL_MS,
  });
  saveStateIfChanged(config, state);

  const lines = [
    "记录工作日志",
    "",
    `已选择工时：${fmtHours(hours)}h`,
    "",
    "现在请发送：",
    `/worklog item 修复筛选回显`,
    "",
    "30 分钟内有效，可随时取消。",
  ];

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("❌ 取消", `/${WORKLOG_COMMAND} x`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handlePresetItemSubmit(
  config: RuntimeConfig,
  senderId: string,
  rawItem: string,
  channel: string,
  logger: LoggerLike,
): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveStateIfChanged(config, state);
  }
  if (!input || input.mode !== "awaiting_item_for_hours" || !Number.isFinite(input.presetHours ?? NaN)) {
    return replyText([
      "记录工作日志",
      "",
      "当前没有待补全的工时状态。",
      "请先执行 /worklog ah 选择工时，或直接用 /worklog 1.5 修复筛选回显。",
    ].join("\n"), true);
  }

  const item = validateWorkItem(rawItem, config);
  const reply = appendForSender(config, senderId, item, input.presetHours as number, logger);
  clearInputState(state, channel, senderId);
  saveStateIfChanged(config, state);
  return replyWithOptionalButtons(channel, reply, buildSuccessButtons());
}

function handleAppend(
  config: RuntimeConfig,
  senderId: string,
  hours: number,
  rawItem: string,
  channel: string,
  logger: LoggerLike,
): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  const item = validateWorkItem(rawItem, config);
  const reply = appendForSender(config, senderId, item, hours, logger);
  return replyWithOptionalButtons(channel, reply, buildSuccessButtons());
}

function appendForSender(config: RuntimeConfig, senderId: string, item: string, hours: number, logger: LoggerLike): string {
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const day = formatLocalDay(new Date());
  const result = appendWorklogEntry({ config, bookPath, day, item, hours });
  logger.info(`[worklog] append sender=${senderId} book=${resolved.key} day=${day} hours=${hours}`);

  return [
    "已记录工作日志",
    "",
    `日志本：${resolved.key}`,
    `日期：${String(result.day)}`,
    `工作项：${item}`,
    `工时：${fmtHours(hours)}h`,
    `今日累计：${fmtHours(Number(result.dayTotalHours))}h / ${String(result.dayItemCount)} 条`,
    `本月累计：${fmtHours(Number(result.monthTotalHours))}h`,
  ].join("\n");
}

function renderToday(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const resolved = resolveBook({ config, senderId });
  enforceReadScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const day = formatLocalDay(new Date());
  const month = day.slice(0, 7);

  try {
    const doc = loadMonthDocument({ config, bookPath, month });
    const section = doc.sections.find((entry) => entry.day === day) ?? null;
    if (!section) {
      return replyWithOptionalButtons(channel, [
        "今日记录",
        "",
        `日志本：${resolved.key}`,
        `日期：${day}`,
        "今天还没有记录。",
      ].join("\n"), [
        [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`)],
        [button("📊 本月统计", `/${WORKLOG_COMMAND} s`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
      ]);
    }

    const totalHours = section.rows.reduce((sum, row) => sum + row.hours, 0);
    const lines = [
      "今日记录",
      "",
      `日志本：${resolved.key}`,
      `日期：${day}`,
      `条数：${section.rows.length}`,
      `工时：${fmtHours(totalHours)}h`,
      "",
      ...section.rows.slice(0, 8).map((row, index) => `${index + 1}. ${row.item} · ${fmtHours(row.hours)}h`),
    ];

    if (section.rows.length > 8) {
      lines.push(`……还有 ${section.rows.length - 8} 条未展开`);
    }
    if (section.comment) {
      lines.push("", `${config.commentPolicy.title}：${section.comment}`);
    }

    return replyWithOptionalButtons(channel, lines.join("\n"), [
      [button("➕ 再记一条", `/${WORKLOG_COMMAND} a`)],
      [button("📊 本月统计", `/${WORKLOG_COMMAND} s`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  } catch {
    return replyWithOptionalButtons(channel, [
      "今日记录",
      "",
      `日志本：${resolved.key}`,
      `日期：${day}`,
      "当前月份还没有日志文件。",
    ].join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }
}

function renderMonth(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const resolved = resolveBook({ config, senderId });
  enforceReadScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const month = formatLocalDay(new Date()).slice(0, 7);

  try {
    const doc = loadMonthDocument({ config, bookPath, month });
    const monthTotal = doc.sections.reduce(
      (sum, section) => sum + section.rows.reduce((inner, row) => inner + row.hours, 0),
      0,
    );
    const ratio = config.monthlyTargetHours > 0 ? (monthTotal / config.monthlyTargetHours) * 100 : 0;
    const recentDays = [...doc.sections]
      .sort((left, right) => right.day.localeCompare(left.day))
      .slice(0, 5)
      .map((section) => `${section.day} · ${fmtHours(section.rows.reduce((sum, row) => sum + row.hours, 0))}h / ${section.rows.length} 条`);

    const lines = [
      "本月统计",
      "",
      `日志本：${resolved.key}`,
      `月份：${month}`,
      `累计工时：${fmtHours(monthTotal)}h`,
      `目标工时：${fmtHours(config.monthlyTargetHours)}h`,
      `剩余工时：${fmtHours(Math.max(0, config.monthlyTargetHours - monthTotal))}h`,
      `完成占比：${ratio.toFixed(2)}%`,
      `记录天数：${doc.sections.length}`,
      `平均每日：${doc.sections.length > 0 ? fmtHours(monthTotal / doc.sections.length) : "0"}h`,
      doc.summaryLine ? `月度摘要：${doc.summaryLine.replace(/^>\s*/, "")}` : "",
      recentDays.length ? "" : "",
      recentDays.length ? "最近记录：" : "暂无明细记录。",
      ...recentDays,
    ].filter(Boolean);

    return replyWithOptionalButtons(channel, lines.join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`), button("📋 今日记录", `/${WORKLOG_COMMAND} t`)],
      [button("🗓 最近7天", `/${WORKLOG_COMMAND} r`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  } catch {
    return replyWithOptionalButtons(channel, [
      "本月统计",
      "",
      `日志本：${resolved.key}`,
      `月份：${month}`,
      "当前月份还没有日志文件。",
    ].join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }
}

function renderRecent(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const resolved = resolveBook({ config, senderId });
  enforceReadScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const month = formatLocalDay(new Date()).slice(0, 7);

  try {
    const doc = loadMonthDocument({ config, bookPath, month });
    const rows = [...doc.sections]
      .sort((left, right) => right.day.localeCompare(left.day))
      .slice(0, 7)
      .map((section) => {
        const total = section.rows.reduce((sum, row) => sum + row.hours, 0);
        return `${section.day} · ${fmtHours(total)}h / ${section.rows.length} 条`;
      });

    return replyWithOptionalButtons(channel, [
      "最近 7 天",
      "",
      `日志本：${resolved.key}`,
      `月份：${month}`,
      rows.length > 0 ? "" : "当前月份还没有记录。",
      ...rows,
    ].filter(Boolean).join("\n"), [
      [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  } catch {
    return replyWithOptionalButtons(channel, [
      "最近 7 天",
      "",
      `日志本：${resolved.key}`,
      `月份：${month}`,
      "当前月份还没有日志文件。",
    ].join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }
}

function renderBooks(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  const currentBook = state.currentBook ?? config.currentBook ?? config.defaultBook ?? "";
  const isAdmin = adminSenderSet(config).has(senderId);
  const isSenderRouted = config.senderRouting.mode === "by_sender_id";
  const boundBook = getBoundBookForSender(config, senderId);

  const lines = [
    "日志本面板",
    "",
    `路由模式：${isSenderRouted ? "按发送者绑定" : "全局当前日志本"}`,
    isSenderRouted ? `当前绑定：${boundBook ?? "未绑定"}` : `当前日志本：${currentBook || "未设置"}`,
    `可用日志本：${Object.keys(books).length}`,
    "",
    ...Object.entries(books).slice(0, 12).map(([key, book]) => {
      const mark = key === (isSenderRouted ? boundBook : currentBook) ? "✅" : "·";
      return `${mark} ${key} · ${book.name}`;
    }),
  ];

  if (isSenderRouted) {
    lines.push("", "当前配置按发送者自动绑定，不提供全局切换。", "如需切换，先改 senderRouting.mode。");
    return replyWithOptionalButtons(channel, lines.join("\n"), [
      [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }

  if (!isAdmin) {
    lines.push("", "只有管理员可以切换全局当前日志本。");
    return replyWithOptionalButtons(channel, lines.join("\n"), [
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }

  const buttons = Object.entries(books)
    .slice(0, 8)
    .map(([key]) => [{ text: `${key === currentBook ? "✅ " : ""}${key}`, callback_data: `/${WORKLOG_COMMAND} use ${key}` }]);
  buttons.push([button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);
  return replyWithOptionalButtons(channel, lines.join("\n"), buttons);
}

function handleUseBook(config: RuntimeConfig, senderId: string, book: string, channel: string): ReplyPayload {
  if (config.senderRouting.mode === "by_sender_id") {
    return replyText("日志本切换\n\n当前是按发送者绑定模式，不能切全局当前日志本。", true);
  }
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本切换\n\n只有管理员可以切换全局当前日志本。", true);
  }

  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  const nextBook = book.trim();
  if (!books[nextBook]) {
    return replyText(`日志本切换\n\n日志本不存在：${nextBook}`, true);
  }

  state.currentBook = nextBook;
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "日志本已切换",
    "",
    `当前日志本：${nextBook}`,
    `名称：${books[nextBook]?.name ?? ""}`,
  ].join("\n"), [
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
    [button("📚 日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderHelp(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const state = loadState(config);
  const lines = [
    "工作日志帮助",
    "",
    `当前日志本：${formatBookSummary(config, state, senderId)}`,
    "",
    "常用命令：",
    `- /${WORKLOG_COMMAND}：打开主菜单`,
    `- /${WORKLOG_COMMAND} today：查看今日记录`,
    `- /${WORKLOG_COMMAND} month：查看本月统计`,
    `- /${WORKLOG_COMMAND} recent：查看最近 7 天摘要`,
    `- /${WORKLOG_COMMAND} books：查看日志本面板`,
    `- /${WORKLOG_COMMAND} 1.5 修复筛选回显：快速记一条`,
    `- /${WORKLOG_COMMAND} ah：先选工时，再发 /worklog item ...`,
    config.senderRouting.mode === "by_sender_id" ? "" : `- /${WORKLOG_COMMAND} use <book>：管理员切换全局当前日志本`,
    config.readAccess.requirePasswordForNonAdminRead ? `- /${WORKLOG_COMMAND} auth <口令>：解锁读取权限` : "",
  ].filter(Boolean);

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleAuth(config: RuntimeConfig, senderId: string, password: string, channel: string): ReplyPayload {
  const auth = authorizeViewerSession(config, senderId, password);
  const lines = [
    "工作日志读取授权",
    "",
    `结果：${auth.result.status}`,
    `说明：${auth.result.message}`,
  ];
  if (auth.expiresAt) {
    lines.push(`过期时间：${new Date(auth.expiresAt * 1000).toLocaleString("zh-CN", { hour12: false })}`);
  }
  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
    [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleCancel(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  return renderMenu(config, senderId, channel);
}

function renderInvalid(config: RuntimeConfig, senderId: string, message: string, channel: string): ReplyPayload {
  const lines = [
    "工作日志",
    "",
    message,
    "",
    "你可以先打开帮助或回主菜单。",
  ];
  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("⚙️ 帮助", `/${WORKLOG_COMMAND} h`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`)],
  ]);
}

function ensureReadAllowed(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload | null {
  const access = checkReadAccess(config, senderId);
  if (access.status === "ok") {
    return null;
  }

  return replyWithOptionalButtons(channel, [
    "工作日志",
    "",
    "当前账号还没有读取权限。",
    `请先执行：/${WORKLOG_COMMAND} auth <口令>`,
  ].join("\n"), [
    [button("⚙️ 帮助", `/${WORKLOG_COMMAND} h`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function formatBookSummary(config: RuntimeConfig, state: RuntimeState, senderId: string): string {
  if (config.senderRouting.mode === "by_sender_id") {
    const boundKey = getBoundBookForSender(config, senderId);
    if (boundKey) {
      const books = getEffectiveBooks(config, state);
      const name = books[boundKey]?.name ?? "";
      return name ? `${boundKey}（${name}）` : boundKey;
    }
    return config.senderRouting.autoCreate ? "首次写入时自动创建" : "未绑定";
  }

  const current = state.currentBook ?? config.currentBook ?? config.defaultBook;
  if (!current) {
    return "未配置";
  }
  const books = getEffectiveBooks(config, state);
  const name = books[current]?.name ?? "";
  return name ? `${current}（${name}）` : current;
}

function formatInputState(state: WorklogInputState): string {
  if (state.mode === "awaiting_item_for_hours") {
    return `待补工作项（${fmtHours(state.presetHours ?? 0)}h）`;
  }
  return "空闲";
}

function clearActiveInput(config: RuntimeConfig, senderId: string, channel: string): void {
  const state = loadState(config);
  clearInputState(state, channel, senderId);
  saveStateIfChanged(config, state);
}

function saveStateIfChanged(config: RuntimeConfig, state: RuntimeState): void {
  saveState(config, state);
}

function normalizeSenderId(ctx: PluginCommandContext): string | null {
  const raw = ctx.senderId ?? ctx.from ?? null;
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function buildMenuButtons(): TelegramInlineKeyboardButton[][] {
  return [
    [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`), button("📋 今日记录", `/${WORKLOG_COMMAND} t`)],
    [button("📊 本月统计", `/${WORKLOG_COMMAND} s`), button("⚙️ 帮助", `/${WORKLOG_COMMAND} h`)],
    [button("🗓 最近7天", `/${WORKLOG_COMMAND} r`), button("📚 日志本", `/${WORKLOG_COMMAND} b`)],
  ];
}

function buildSuccessButtons(): TelegramInlineKeyboardButton[][] {
  return [
    [button("➕ 再记一条", `/${WORKLOG_COMMAND} a`), button("📋 今日记录", `/${WORKLOG_COMMAND} t`)],
    [button("📊 本月统计", `/${WORKLOG_COMMAND} s`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ];
}

function button(text: string, callbackData: string): TelegramInlineKeyboardButton {
  return { text, callback_data: callbackData };
}

function replyText(text: string, isError = false): ReplyPayload {
  return { text, isError };
}

function replyWithButtons(text: string, buttons: TelegramInlineKeyboardButton[][], isError = false): ReplyPayload {
  return {
    text,
    isError,
    channelData: {
      telegram: {
        buttons,
      },
    },
  };
}

function replyWithOptionalButtons(
  channel: string,
  text: string,
  buttons: TelegramInlineKeyboardButton[][],
  isError = false,
): ReplyPayload {
  if (channel === "telegram") {
    return replyWithButtons(text, buttons, isError);
  }
  return replyText(text, isError);
}

function formatLocalDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

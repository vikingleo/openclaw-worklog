import os from "node:os";
import path from "node:path";

import { authorizeViewer, checkReadAccess, locateBookPath, resolveBook } from "./access.js";
import { buildRuntimeConfigFromPlugin } from "./config.js";
import { enforceReadScope, enforceWriteScope, validateComment, validateWorkItem } from "./guards.js";
import { getEffectiveBooks, getEffectiveCurrentBook, loadState, saveState } from "./state-store.js";
import type { LoggerLike, RuntimeConfig } from "./types.js";
import { appendWorklogEntry, locateMonthFile, upsertDayComment } from "./worklog-storage.js";

export function registerWorklogCli(params: {
  program: any;
  openclawConfig: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: LoggerLike;
}) {
  const { program, openclawConfig, pluginConfig, logger } = params;
  const root = program
    .command("worklog")
    .description("工作日志账本插件工具")
    .addHelpText(
      "after",
      () => [
        "",
        "示例：",
        "  openclaw worklog status",
        "  openclaw worklog books",
        "  openclaw worklog append --sender-id telegram:YOUR_USER_ID --item \"修复筛选状态回显\" --hours 1.5",
        "  openclaw worklog comment --sender-id telegram:YOUR_USER_ID --day 2026-03-06 --comment \"这天主要在补坑。\"",
        "  openclaw worklog preview-url --sender-id telegram:YOUR_USER_ID --month 2026-03",
      ].join("\n"),
    );

  root
    .command("status")
    .description("显示当前生效配置摘要")
    .action(() => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const state = loadState(config);
      console.log(JSON.stringify(summarizeConfig(config, state), null, 2));
    });

  root
    .command("books")
    .description("列出当前可用日志本")
    .action(() => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const state = loadState(config);
      const books = getEffectiveBooks(config, state);
      console.log(
        JSON.stringify(
          {
            currentBook: getEffectiveCurrentBook(config, state),
            books: Object.entries(books).map(([key, book]) => ({ key, name: book.name, path: book.path })),
          },
          null,
          2,
        ),
      );
    });

  root
    .command("current")
    .description("显示当前默认日志本")
    .action(() => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const state = loadState(config);
      console.log(JSON.stringify({ currentBook: getEffectiveCurrentBook(config, state) }, null, 2));
    });

  root
    .command("switch")
    .description("切换当前默认日志本")
    .requiredOption("--book <key>", "日志本 key")
    .action((options: { book: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const state = loadState(config);
      const books = getEffectiveBooks(config, state);
      if (!books[options.book]) {
        throw new Error(`日志本不存在：${options.book}`);
      }
      state.currentBook = options.book;
      saveState(config, state);
      console.log(JSON.stringify({ status: "ok", currentBook: options.book }, null, 2));
    });

  root
    .command("resolve")
    .description("根据 senderId 解析目标日志本")
    .requiredOption("--sender-id <senderId>", "消息发送者标识")
    .option("--book <key>", "显式指定日志本 key")
    .action((options: { senderId: string; book?: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const result = resolveBook({
        config,
        senderId: options.senderId.trim(),
        requestedBook: options.book,
      });
      const books = getEffectiveBooks(config, loadState(config));
      console.log(
        JSON.stringify(
          {
            status: "ok",
            senderId: options.senderId.trim(),
            book: result.key,
            bookCreated: result.created,
            bookName: books[result.key]?.name ?? "",
            bookPath: books[result.key]?.path ?? "",
          },
          null,
          2,
        ),
      );
    });

  root
    .command("append")
    .description("追加一条工作日志")
    .requiredOption("--sender-id <senderId>", "消息发送者标识")
    .requiredOption("--item <text>", "工作项")
    .requiredOption("--hours <hours>", "工时")
    .option("--book <key>", "显式指定日志本 key")
    .option("--day <yyyy-mm-dd>", "日期，默认今天")
    .action((options: { senderId: string; item: string; hours: string; book?: string; day?: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const senderId = options.senderId.trim();
      const hours = Number(options.hours);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error("--hours 必须大于 0。");
      }
      const day = normalizeDay(options.day);
      const item = validateWorkItem(options.item, config);
      const resolved = resolveBook({ config, senderId, requestedBook: options.book });
      enforceWriteScope({ config, senderId, key: resolved.key });
      const bookPath = locateBookPath(config, resolved.key);
      const result = appendWorklogEntry({ config, bookPath, day, item, hours });
      logger.info(`[worklog] 已写入 ${resolved.key} ${day}`);
      console.log(JSON.stringify({ book: resolved.key, ...result }, null, 2));
    });

  root
    .command("comment")
    .description("为指定日期补充或覆盖锐评")
    .requiredOption("--sender-id <senderId>", "消息发送者标识")
    .requiredOption("--day <yyyy-mm-dd>", "日期")
    .requiredOption("--comment <text>", "锐评内容")
    .option("--book <key>", "显式指定日志本 key")
    .action((options: { senderId: string; day: string; comment: string; book?: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      if (!config.commentPolicy.enabled) {
        throw new Error("当前配置未启用锐评能力。");
      }
      const senderId = options.senderId.trim();
      const day = normalizeDay(options.day, true);
      if (!config.commentPolicy.allowSameDayComment && day === todayIso()) {
        throw new Error("当前配置禁止为今天补写锐评。");
      }
      const comment = validateComment(options.comment, config);
      const resolved = resolveBook({ config, senderId, requestedBook: options.book });
      enforceWriteScope({ config, senderId, key: resolved.key });
      const bookPath = locateBookPath(config, resolved.key);
      const result = upsertDayComment({ config, bookPath, day, comment });
      logger.info(`[worklog] 已补写锐评 ${resolved.key} ${day}`);
      console.log(JSON.stringify({ book: resolved.key, ...result }, null, 2));
    });

  root
    .command("check-read")
    .description("检查读取权限状态")
    .requiredOption("--sender-id <senderId>", "消息发送者标识")
    .action((options: { senderId: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const result = checkReadAccess(config, options.senderId.trim());
      console.log(
        JSON.stringify(
          {
            status: result.status,
            message: result.message,
            isAdmin: result.isAdmin,
            requiresPassword: result.requiresPassword,
          },
          null,
          2,
        ),
      );
    });

  root
    .command("auth-read")
    .description("使用口令为浏览者授权读取")
    .requiredOption("--sender-id <senderId>", "消息发送者标识")
    .requiredOption("--password <password>", "口令")
    .action((options: { senderId: string; password: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const result = authorizeViewer(config, options.senderId.trim(), options.password);
      console.log(
        JSON.stringify(
          {
            status: result.status,
            message: result.message,
            isAdmin: result.isAdmin,
            requiresPassword: result.requiresPassword,
          },
          null,
          2,
        ),
      );
    });

  root
    .command("locate")
    .description("定位某个月的日志文件")
    .requiredOption("--sender-id <senderId>", "消息发送者标识")
    .requiredOption("--month <yyyy-mm>", "月份")
    .option("--book <key>", "显式指定日志本 key")
    .option("--require-read-access", "同时检查读取权限", false)
    .action((options: { senderId: string; month: string; book?: string; requireReadAccess?: boolean }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const senderId = options.senderId.trim();
      if (options.requireReadAccess) {
        const access = checkReadAccess(config, senderId);
        if (access.status !== "ok") {
          console.log(
            JSON.stringify(
              {
                status: access.status,
                message: access.message,
                isAdmin: access.isAdmin,
                requiresPassword: access.requiresPassword,
              },
              null,
              2,
            ),
          );
          return;
        }
      }
      const resolved = resolveBook({ config, senderId, requestedBook: options.book });
      enforceReadScope({ config, senderId, key: resolved.key });
      const bookPath = locateBookPath(config, resolved.key);
      console.log(
        JSON.stringify(
          {
            status: "ok",
            book: resolved.key,
            ...locateMonthFile(bookPath, options.month.trim()),
          },
          null,
          2,
        ),
      );
    });

  root
    .command("preview-url")
    .description("生成预览页面地址")
    .requiredOption("--sender-id <senderId>", "消息发送者标识")
    .option("--month <yyyy-mm>", "月份，默认当月")
    .option("--book <key>", "显式指定日志本 key")
    .action((options: { senderId: string; month?: string; book?: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const month = normalizeMonth(options.month);
      console.log(JSON.stringify({
        url: buildPreviewUrl(config, options.senderId.trim(), month, options.book),
      }, null, 2));
    });

  root
    .command("self-test")
    .description("执行脱离宿主环境的插件自检")
    .action(() => {
      const config = buildSmokeConfig(resolveCliRuntimeConfig({ openclawConfig, pluginConfig }));
      const senderId = "telegram:demo-owner";
      const resolved = resolveBook({ config, senderId });
      const bookPath = locateBookPath(config, resolved.key);
      appendWorklogEntry({
        config,
        bookPath,
        day: "2026-03-06",
        item: "示例工作项 A",
        hours: 1.5,
      });
      const appended = appendWorklogEntry({
        config,
        bookPath,
        day: "2026-03-07",
        item: "示例工作项 B",
        hours: 2,
      });
      const commented = upsertDayComment({
        config,
        bookPath,
        day: "2026-03-06",
        comment: "昨天主要是在收拾坑。",
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            stateFile: config.stateFile,
            book: resolved.key,
            previewUrl: buildPreviewUrl(config, senderId, "2026-03"),
            appendResult: appended,
            commentResult: commented,
          },
          null,
          2,
        ),
      );
    });
}

function resolveCliRuntimeConfig(params: {
  openclawConfig: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
}): RuntimeConfig {
  return buildRuntimeConfigFromPlugin(params);
}

function summarizeConfig(config: RuntimeConfig, state: ReturnType<typeof loadState>) {
  return {
    enabled: config.enabled,
    dataRoot: config.dataRoot,
    stateFile: config.stateFile,
    monthlyTargetHours: config.monthlyTargetHours,
    senderRoutingMode: config.senderRouting.mode,
    currentBook: getEffectiveCurrentBook(config, state),
    staticBookCount: Object.keys(config.books).length,
    runtimeBookCount: Object.keys(getEffectiveBooks(config, state)).length,
    readPasswordRequired: config.readAccess.requirePasswordForNonAdminRead,
    commentEnabled: config.commentPolicy.enabled,
    previewEnabled: config.preview.enabled,
    previewBaseUrl: `http://${config.preview.host}:${config.preview.port}${config.preview.basePath}`,
  };
}

function normalizeDay(input?: string, required = false): string {
  const value = input?.trim() || (!required ? todayIso() : "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("日期必须是 YYYY-MM-DD。");
  }
  return value;
}

function normalizeMonth(input?: string): string {
  const value = input?.trim() || currentMonth();
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error("月份必须是 YYYY-MM。");
  }
  return value;
}

function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function buildPreviewUrl(config: RuntimeConfig, senderId: string, month: string, book?: string): string {
  const base = `http://${config.preview.host}:${config.preview.port}${config.preview.basePath}`;
  const url = new URL(base);
  url.searchParams.set("senderId", senderId);
  url.searchParams.set("month", month);
  if (book?.trim()) {
    url.searchParams.set("book", book.trim());
  }
  return url.toString();
}

function buildSmokeConfig(config: RuntimeConfig): RuntimeConfig {
  const root = path.join(os.tmpdir(), "openclaw-worklog-smoke");
  return {
    ...config,
    dataRoot: root,
    stateFile: path.join(root, ".plugin-state.json"),
    books: {
      demo: {
        name: "示例账本",
        path: path.join(root, "users", "demo"),
      },
    },
    defaultBook: "demo",
    currentBook: "demo",
    senderRouting: {
      ...config.senderRouting,
      mode: "by_sender_id",
      autoCreate: true,
      allowAutoBindSenders: [],
      bindings: { "telegram:demo-owner": "demo" },
      bookPathTemplate: path.join(root, "users", "{key}"),
    },
    readAccess: {
      ...config.readAccess,
      requirePasswordForNonAdminRead: false,
      adminSenderIds: ["telegram:demo-owner"],
    },
    writeGuard: {
      ...config.writeGuard,
      adminSenderIds: ["telegram:demo-owner"],
      restrictedPathPrefix: path.join(root, "users"),
      review: {
        ...config.writeGuard.review,
        forbiddenPatterns: [],
      },
    },
    commentPolicy: {
      ...config.commentPolicy,
      allowSameDayComment: true,
    },
    preview: {
      ...config.preview,
      enabled: true,
      host: "127.0.0.1",
      port: 33210,
      basePath: "/worklog-preview",
    },
  };
}

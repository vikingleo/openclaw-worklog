import fs from "node:fs";
import path from "node:path";

import { adminSenderSet, authorizeViewerSession, checkReadAccess, getBoundBookForSender, locateBookPath, resolveBook } from "./access.js";
import { buildRuntimeConfigFromPlugin, normalizeBookPath } from "./config.js";
import { enforceReadScope, enforceWriteScope, validateComment, validateWorkItem } from "./guards.js";
import { getAiAvailability, polishWorklogBatch, polishWorklogDraft, suggestWorklogComment } from "./ai-assist.js";
import {
  clearInputState,
  getEffectiveBindings,
  getEffectiveBooks,
  getInputState,
  loadState,
  purgeExpiredInputStates,
  saveState,
  setInputState,
  ensureBookDir,
} from "./state-store.js";
import { parseTelegramTarget, TelegramPanelDelivery, type TelegramPanelMessage, type TelegramPanelTarget } from "./telegram-panel-delivery.js";
import type { LoggerLike, RuntimeConfig, RuntimeState, WorklogBatchRow, WorklogInputState } from "./types.js";
import { WorklogPanelStore, type WorklogPanelRecord } from "./worklog-panel-store.js";
import { buildSignedPreviewUrl } from "./preview-share.js";
import type { OpenClawPluginApi, PluginCommandContext, ReplyPayload, TelegramInlineKeyboardButton } from "openclaw/plugin-sdk";
import { appendWorklogEntry, deleteWorklogEntries, deleteWorklogEntry, fmtHours, loadMonthDocument, replaceWorklogEntry, upsertDayComment } from "./worklog-storage.js";

const WORKLOG_COMMAND = "worklog";
const INPUT_STATE_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_PANEL_REUSE_MAX_AGE_MS = 10 * 60 * 1000;
const SILENT_REPLY_TOKEN = "NO_REPLY";

type WorklogAction =
  | { kind: "menu" }
  | { kind: "today" }
  | { kind: "month" }
  | { kind: "recent" }
  | { kind: "books" }
  | { kind: "create-book-prompt" }
  | { kind: "rename-book-prompt"; book: string }
  | { kind: "create-book"; book: string; name: string }
  | { kind: "rename-book"; book: string; name: string }
  | { kind: "bind-book-prompt" }
  | { kind: "bindings-list"; page: number; query: string }
  | { kind: "bind-book"; sender: string; book: string }
  | { kind: "unbind-book"; sender: string }
  | { kind: "archive-book-confirm"; book: string }
  | { kind: "archive-book"; book: string }
  | { kind: "delete-book-confirm"; book: string }
  | { kind: "delete-book"; book: string }
  | { kind: "web" }
  | { kind: "help" }
  | { kind: "add" }
  | { kind: "batch-prompt" }
  | { kind: "batch-draft"; day: string | null; raw: string }
  | { kind: "confirm-batch-draft" }
  | { kind: "direct-input" }
  | { kind: "hours-only" }
  | { kind: "preset-hours"; hours: number }
  | { kind: "submit-preset-item"; item: string }
  | { kind: "append-draft"; day: string; hours: number; item: string; sourceText: string }
  | { kind: "confirm-append-draft" }
  | { kind: "rewrite-append-draft" }
  | { kind: "comment-prompt"; day: string | null }
  | { kind: "comment-save"; day: string | null; comment: string }
  | { kind: "confirm-comment-draft" }
  | { kind: "ai-polish-draft" }
  | { kind: "ai-detect-comment"; day: string | null }
  | { kind: "edit-entry"; day: string; rowIndex: number }
  | { kind: "replace-entry"; hours: number; item: string }
  | { kind: "delete-entry-confirm"; day: string; rowIndex: number }
  | { kind: "delete-entry"; day: string; rowIndex: number }
  | { kind: "delete-entries-confirm"; day: string; rowIndices: number[] }
  | { kind: "delete-entries"; day: string; rowIndices: number[] }
  | { kind: "delete-selection-start"; day: string }
  | { kind: "delete-selection-toggle"; day: string; rowIndex: number }
  | { kind: "delete-selection-clear"; day: string }
  | { kind: "delete-selection-confirm"; day: string }
  | { kind: "append"; hours: number; item: string }
  | { kind: "use-book"; book: string }
  | { kind: "auth"; password: string }
  | { kind: "cancel" }
  | { kind: "invalid"; message: string };

type WorklogPanelEnvelope = {
  panelId: string | null;
  rawActionArgs: string;
};

export function registerWorklogChatCommands(api: OpenClawPluginApi): void {
  const handler = async (ctx: PluginCommandContext) => await handleWorklogCommand(ctx, api);

  api.registerCommand({
    name: WORKLOG_COMMAND,
    description: "工作日志 Telegram 卡片与命令入口",
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

  const envelope = parsePanelEnvelope(ctx.args ?? "");
  const action = parseWorklogAction(envelope.rawActionArgs);

  try {
    const payload = await executeAction({
      action,
      config,
      senderId,
      channel: ctx.channel,
      logger: api.logger,
    });

    if (ctx.channel === "telegram") {
      const telegramRuntime = resolveTelegramRuntime(api.config as Record<string, unknown>);
      const target = parseTelegramTarget(ctx.to ?? ctx.from, ctx.messageThreadId);
      if (telegramRuntime && target) {
        return await handleTelegramPanelDelivery({
          config,
          senderId,
          envelope,
          payload,
          target,
          telegramRuntime,
        });
      }
    }

    return payload;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = humanizeWorklogError(rawMessage, senderId);
    api.logger.warn(`[worklog] command failed sender=${senderId} err=${rawMessage}`);
    return replyText(`工作日志\n\n${message}`, true);
  }
}

async function executeAction(params: {
  action: WorklogAction;
  config: RuntimeConfig;
  senderId: string;
  channel: string;
  logger: LoggerLike;
}): Promise<ReplyPayload> {
  const { action, config, senderId, channel, logger } = params;

  switch (action.kind) {
    case "menu":
      return renderMenu(config, senderId, channel);
    case "today":
      return renderToday(config, senderId, channel);
    case "month":
      return renderMonth(config, senderId, channel);
    case "recent":
      return renderRecent(config, senderId, channel);
    case "books":
      return renderBooks(config, senderId, channel);
    case "create-book-prompt":
      return renderCreateBookPrompt(config, senderId, channel);
    case "rename-book-prompt":
      return renderRenameBookPrompt(config, senderId, action.book, channel);
    case "create-book":
      return handleCreateBook(config, senderId, action.book, action.name, channel);
    case "rename-book":
      return handleRenameBook(config, senderId, action.book, action.name, channel);
    case "bind-book-prompt":
      return renderBindBookPrompt(config, senderId, channel);
    case "bindings-list":
      return renderBindingsList(config, senderId, action.page, action.query, channel);
    case "bind-book":
      return handleBindBook(config, senderId, action.sender, action.book, channel);
    case "unbind-book":
      return handleUnbindBook(config, senderId, action.sender, channel);
    case "archive-book-confirm":
      return renderArchiveBookConfirm(config, senderId, action.book, channel);
    case "archive-book":
      return handleArchiveBook(config, senderId, action.book, channel);
    case "delete-book-confirm":
      return renderDeleteBookConfirm(config, senderId, action.book, channel);
    case "delete-book":
      return handleDeleteBook(config, senderId, action.book, channel);
    case "web":
      return renderWebAccess(config, senderId, channel);
    case "help":
      return renderHelp(config, senderId, channel);
    case "add":
      return renderAddEntry(config, senderId, channel);
    case "batch-prompt":
      return renderBatchPrompt(config, senderId, channel);
    case "batch-draft":
      return renderBatchDraftConfirm(config, senderId, action.day, action.raw, channel);
    case "confirm-batch-draft":
      return handleConfirmBatchDraft(config, senderId, channel, logger);
    case "direct-input":
      return renderDirectInput(config, senderId, channel);
    case "hours-only":
      return renderHoursOnly(config, senderId, channel);
    case "preset-hours":
      return renderPresetHoursPicked(config, senderId, action.hours, channel);
    case "submit-preset-item":
      return handlePresetItemSubmit(config, senderId, action.item, channel, logger);
    case "append-draft":
      return renderAppendDraftConfirm(config, senderId, action.day, action.hours, action.item, action.sourceText, channel);
    case "confirm-append-draft":
      return handleConfirmAppendDraft(config, senderId, channel, logger);
    case "rewrite-append-draft":
      return renderRewriteAppendDraft(config, senderId, channel);
    case "comment-prompt":
      return renderCommentPrompt(config, senderId, action.day, channel);
    case "comment-save":
      return handleCommentSave(config, senderId, action.day, action.comment, channel, logger);
    case "confirm-comment-draft":
      return handleConfirmCommentDraft(config, senderId, channel, logger);
    case "ai-polish-draft":
      return await handleAiPolishDraft(config, senderId, channel);
    case "ai-detect-comment":
      return await handleAiDetectComment(config, senderId, action.day, channel);
    case "edit-entry":
      return handleEditEntryStart(config, senderId, action.day, action.rowIndex, channel);
    case "replace-entry":
      return handleReplaceEntry(config, senderId, action.hours, action.item, channel, logger);
    case "delete-entry-confirm":
      return renderDeleteEntryConfirm(config, senderId, action.day, action.rowIndex, channel);
    case "delete-entry":
      return handleDeleteEntry(config, senderId, action.day, action.rowIndex, channel, logger);
    case "delete-entries-confirm":
      return renderDeleteEntriesConfirm(config, senderId, action.day, action.rowIndices, channel);
    case "delete-entries":
      return handleDeleteEntries(config, senderId, action.day, action.rowIndices, channel, logger);
    case "delete-selection-start":
      return handleDeleteSelectionStart(config, senderId, action.day, channel);
    case "delete-selection-toggle":
      return handleDeleteSelectionToggle(config, senderId, action.day, action.rowIndex, channel);
    case "delete-selection-clear":
      return handleDeleteSelectionClear(config, senderId, action.day, channel);
    case "delete-selection-confirm":
      return handleDeleteSelectionConfirm(config, senderId, action.day, channel);
    case "append":
      return handleAppend(config, senderId, action.hours, action.item, channel, logger);
    case "use-book":
      return handleUseBook(config, senderId, action.book, channel);
    case "auth":
      return handleAuth(config, senderId, action.password, channel);
    case "cancel":
      return handleCancel(config, senderId, channel);
    case "invalid":
      return renderInvalid(config, senderId, action.message, channel);
  }
}

async function handleTelegramPanelDelivery(params: {
  config: RuntimeConfig;
  senderId: string;
  envelope: WorklogPanelEnvelope;
  payload: ReplyPayload;
  target: TelegramPanelTarget;
  telegramRuntime: TelegramRuntime;
}): Promise<ReplyPayload> {
  const { config, senderId, envelope, payload, target, telegramRuntime } = params;
  const store = new WorklogPanelStore(resolvePanelStateFile(config));
  const delivery = new TelegramPanelDelivery(telegramRuntime);
  const now = Date.now();

  await purgeExpiredTelegramPanels({ store, delivery, now });

  if (envelope.panelId) {
    const panel = store.get(envelope.panelId);
    if (!panel || panel.ownerSenderId !== senderId || isTelegramPanelExpired(panel, now)) {
      if (panel && isTelegramPanelExpired(panel, now)) {
        store.delete(panel.panelId);
        await deleteTelegramPanelMessage(delivery, panel);
      }
      return replyText(`工作日志\n\n卡片已过期，请重新发送 /${WORKLOG_COMMAND} 打开。`, true);
    }

    const activePanel = needsCompactPanelId(panel.panelId) ? rotateTelegramPanel(store, panel) : panel;
    const message = toTelegramPanelMessage(payload, activePanel.panelId);
    await safeEditOrResend({
      delivery,
      store,
      panelId: activePanel.panelId,
      target: { chatId: activePanel.chatId, threadId: activePanel.threadId },
      messageId: activePanel.messageId,
      senderId,
      message,
    });
    return { text: SILENT_REPLY_TOKEN };
  }

  const existing = store.findByOwnerChat(senderId, target.chatId, target.threadId);
  if (existing && !isTelegramPanelExpired(existing, now)) {
    const activePanel = needsCompactPanelId(existing.panelId) ? rotateTelegramPanel(store, existing) : existing;
    const message = toTelegramPanelMessage(payload, activePanel.panelId);
    await safeEditOrResend({
      delivery,
      store,
      panelId: activePanel.panelId,
      target,
      messageId: activePanel.messageId,
      senderId,
      message,
    });
    return {};
  }

  const panel = store.create({ chatId: target.chatId, threadId: target.threadId, ownerSenderId: senderId });
  const message = toTelegramPanelMessage(payload, panel.panelId);
  const sent = await delivery.sendMessage(target, message);
  store.update(panel.panelId, (current) => ({
    ...current,
    messageId: sent.messageId,
    updatedAtMs: Date.now(),
  }));
  return {};
}

function needsCompactPanelId(panelId: string): boolean {
  return panelId.length > 12;
}

function rotateTelegramPanel(store: WorklogPanelStore, panel: WorklogPanelRecord): WorklogPanelRecord {
  store.delete(panel.panelId);
  const next = store.create({
    chatId: panel.chatId,
    threadId: panel.threadId,
    ownerSenderId: panel.ownerSenderId,
  });
  return store.update(next.panelId, (current) => ({
    ...current,
    messageId: panel.messageId,
    createdAtMs: panel.createdAtMs,
    updatedAtMs: Date.now(),
  })) ?? next;
}

async function safeEditOrResend(params: {
  delivery: TelegramPanelDelivery;
  store: WorklogPanelStore;
  panelId: string;
  target: TelegramPanelTarget;
  messageId: number | null;
  senderId: string;
  message: TelegramPanelMessage;
}): Promise<void> {
  const { delivery, store, panelId, target, messageId, senderId, message } = params;
  try {
    if (messageId) {
      await delivery.editMessage(target, messageId, message);
      store.update(panelId, (current) => ({ ...current, updatedAtMs: Date.now() }));
      return;
    }
  } catch (error) {
    const text = String(error).toLowerCase();
    if (!text.includes("message") && !text.includes("chat")) {
      throw error;
    }
  }

  const sent = await delivery.sendMessage(target, message);
  store.update(panelId, () => ({
    panelId,
    chatId: target.chatId,
    threadId: target.threadId,
    ownerSenderId: senderId,
    messageId: sent.messageId,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  }));
}

function isTelegramPanelExpired(panel: WorklogPanelRecord, now: number): boolean {
  return now - panel.updatedAtMs > TELEGRAM_PANEL_REUSE_MAX_AGE_MS;
}

async function purgeExpiredTelegramPanels(params: {
  store: WorklogPanelStore;
  delivery: TelegramPanelDelivery;
  now: number;
}): Promise<void> {
  const expiredPanels = params.store.purgeExpired((panel) => isTelegramPanelExpired(panel, params.now));
  for (const panel of expiredPanels) {
    await deleteTelegramPanelMessage(params.delivery, panel);
  }
}

async function deleteTelegramPanelMessage(delivery: TelegramPanelDelivery, panel: WorklogPanelRecord): Promise<void> {
  if (!panel.messageId) {
    return;
  }

  try {
    await delivery.deleteMessage({ chatId: panel.chatId, threadId: panel.threadId }, panel.messageId);
  } catch {
    return;
  }
}

function parsePanelEnvelope(rawArgs: string): WorklogPanelEnvelope {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === "p" && tokens[1]) {
    return {
      panelId: tokens[1],
      rawActionArgs: tokens.slice(2).join(" "),
    };
  }
  return {
    panelId: null,
    rawActionArgs: rawArgs,
  };
}

function parseWorklogAction(rawArgs: string): WorklogAction {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { kind: "menu" };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const head = tokens[0]?.toLowerCase() ?? "";

  if (["m", "menu", "home"].includes(head)) return { kind: "menu" };
  if (["t", "today"].includes(head)) return { kind: "today" };
  if (["s", "stat", "stats", "month", "monthly"].includes(head)) return { kind: "month" };
  if (["r", "recent", "week"].includes(head)) return { kind: "recent" };
  if (["b", "book", "books"].includes(head)) return { kind: "books" };
  if (["bc", "book-create"].includes(head)) return { kind: "create-book-prompt" };
  if (["bb", "book-bind"].includes(head)) return { kind: "bind-book-prompt" };
  if (["bl", "bindings"].includes(head)) {
    const maybePage = Number.parseInt(tokens[1] ?? "1", 10);
    const hasNumericPage = Number.isInteger(maybePage) && maybePage > 0 && String(tokens[1] ?? "").trim() !== "";
    const page = hasNumericPage ? maybePage : 1;
    const query = (hasNumericPage ? tokens.slice(2) : tokens.slice(1)).join(" ").trim();
    return { kind: "bindings-list", page, query };
  }
  if (["w", "web", "preview"].includes(head)) return { kind: "web" };
  if (["h", "help"].includes(head)) return { kind: "help" };
  if (["a", "add"].includes(head)) return { kind: "add" };
  if (["batch", "bulk", "many"].includes(head)) {
    const payload = trimmed.replace(/^\S+\s*/u, "");
    const parsed = parseBatchCommandPayload(payload);
    if (!parsed.raw) return { kind: "batch-prompt" };
    return { kind: "batch-draft", day: parsed.day, raw: parsed.raw };
  }
  if (["batch-ok", "batch-save"].includes(head)) return { kind: "confirm-batch-draft" };
  if (["ai", "input"].includes(head)) return { kind: "direct-input" };
  if (["ah", "hours"].includes(head)) return { kind: "hours-only" };
  if (["ok", "confirm", "submit", "save"].includes(head)) return { kind: "confirm-append-draft" };
  if (["modify", "rewrite", "revise", "edit-draft"].includes(head)) return { kind: "rewrite-append-draft" };
  if (["comment-ok", "comment-save-now"].includes(head)) return { kind: "confirm-comment-draft" };
  if (["ai-polish", "polish-ai"].includes(head)) return { kind: "ai-polish-draft" };
  if (["ai-comment", "comment-ai", "review-ai"].includes(head)) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(tokens[1] ?? "") ? (tokens[1] ?? null) : null;
    return { kind: "ai-detect-comment", day };
  }
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

  if (["replace", "rp"].includes(head)) {
    const payload = trimmed.replace(/^\S+\s*/u, "").trim();
    const parsed = parseAppendPayload(payload);
    if (!parsed) {
      return { kind: "invalid", message: "替换格式不对。请用：/worklog replace 1.5 修复筛选回显" };
    }
    return { kind: "replace-entry", hours: parsed.hours, item: parsed.item };
  }

  if (["edit", "e"].includes(head)) {
    const ref = parseEntryReference(tokens[1] ?? "", tokens[2] ?? "");
    if (!ref) {
      return { kind: "invalid", message: "编辑格式不对。请用：/worklog edit 2026-03-08 1" };
    }
    return { kind: "edit-entry", day: ref.day, rowIndex: ref.rowIndex };
  }

  if (["delete", "dc"].includes(head)) {
    const refs = parseEntryReferences(tokens[1] ?? "", tokens.slice(2).join(" "));
    if (!refs) {
      return { kind: "invalid", message: "删除格式不对。请用：/worklog delete 2026-03-08 1 或 /worklog delete 2026-03-08 1,2,3" };
    }
    return refs.rowIndices.length === 1
      ? { kind: "delete-entry-confirm", day: refs.day, rowIndex: refs.rowIndices[0] }
      : { kind: "delete-entries-confirm", day: refs.day, rowIndices: refs.rowIndices };
  }

  if (["dd", "delete-now"].includes(head)) {
    const refs = parseEntryReferences(tokens[1] ?? "", tokens.slice(2).join(" "));
    if (!refs) {
      return { kind: "invalid", message: "删除参数无效。" };
    }
    return refs.rowIndices.length === 1
      ? { kind: "delete-entry", day: refs.day, rowIndex: refs.rowIndices[0] }
      : { kind: "delete-entries", day: refs.day, rowIndices: refs.rowIndices };
  }

  if (["dm", "delete-mode"].includes(head)) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(tokens[1] ?? "") ? (tokens[1] ?? formatLocalDay(new Date())) : formatLocalDay(new Date());
    return { kind: "delete-selection-start", day };
  }

  if (["dt", "delete-toggle"].includes(head)) {
    const ref = parseEntryReference(tokens[1] ?? "", tokens[2] ?? "");
    if (!ref) {
      return { kind: "invalid", message: "批量删除切换格式不对。请用：/worklog dt 2026-03-08 1" };
    }
    return { kind: "delete-selection-toggle", day: ref.day, rowIndex: ref.rowIndex };
  }

  if (["dclr", "delete-clear"].includes(head)) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(tokens[1] ?? "") ? (tokens[1] ?? formatLocalDay(new Date())) : formatLocalDay(new Date());
    return { kind: "delete-selection-clear", day };
  }

  if (["dok", "delete-ok"].includes(head)) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(tokens[1] ?? "") ? (tokens[1] ?? formatLocalDay(new Date())) : formatLocalDay(new Date());
    return { kind: "delete-selection-confirm", day };
  }

  if (head === "auth") {
    const password = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!password) {
      return { kind: "invalid", message: "请提供口令，例如：/worklog auth 你的口令" };
    }
    return { kind: "auth", password };
  }

  if (["c", "comment", "note"].includes(head)) {
    const payload = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!payload) {
      return { kind: "comment-prompt", day: null };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(payload)) {
      return { kind: "comment-prompt", day: payload };
    }
    const dated = payload.match(/^(\d{4}-\d{2}-\d{2})\s+([\s\S]+)$/u);
    if (dated) {
      return { kind: "comment-save", day: dated[1], comment: dated[2].trim() };
    }
    return { kind: "comment-save", day: null, comment: payload };
  }

  if (["use", "u"].includes(head)) {
    const book = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!book) {
      return { kind: "invalid", message: "请提供日志本 key，例如：/worklog use demo" };
    }
    return { kind: "use-book", book };
  }

  if (["br", "book-rename"].includes(head)) {
    const book = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!book) {
      return { kind: "invalid", message: "请提供日志本 key，例如：/worklog br demo" };
    }
    return { kind: "rename-book-prompt", book };
  }

  if (head === "create") {
    const payload = trimmed.replace(/^\S+\s*/u, "").trim();
    const match = payload.match(/^(\S+)\s+(.+)$/u);
    if (!match) {
      return { kind: "invalid", message: "创建格式不对。请用：/worklog create demo 演示日志本" };
    }
    return { kind: "create-book", book: match[1], name: match[2].trim() };
  }

  if (head === "rename") {
    const payload = trimmed.replace(/^\S+\s*/u, "").trim();
    const match = payload.match(/^(\S+)\s+(.+)$/u);
    if (!match) {
      return { kind: "invalid", message: "重命名格式不对。请用：/worklog rename demo 新名字" };
    }
    return { kind: "rename-book", book: match[1], name: match[2].trim() };
  }


  if (head === "bind") {
    const payload = trimmed.replace(/^\S+\s*/u, "").trim();
    const match = payload.match(/^(\S+)\s+(\S+)$/u);
    if (!match) {
      return { kind: "invalid", message: "绑定格式不对。请用：/worklog bind telegram:123 demo" };
    }
    return { kind: "bind-book", sender: match[1], book: match[2] };
  }

  if (head === "unbind") {
    const targetSender = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!targetSender) {
      return { kind: "invalid", message: "解绑格式不对。请用：/worklog unbind telegram:123" };
    }
    return { kind: "unbind-book", sender: targetSender };
  }


  if (["ba", "book-archive"].includes(head)) {
    const book = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!book) {
      return { kind: "invalid", message: "归档格式不对。请用：/worklog ba demo" };
    }
    return { kind: "archive-book-confirm", book };
  }

  if (["baa", "book-archive-apply"].includes(head)) {
    const book = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!book) {
      return { kind: "invalid", message: "归档参数无效。" };
    }
    return { kind: "archive-book", book };
  }

  if (["bd", "book-delete"].includes(head)) {
    const book = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!book) {
      return { kind: "invalid", message: "删除格式不对。请用：/worklog bd demo" };
    }
    return { kind: "delete-book-confirm", book };
  }

  if (["bdd", "book-delete-apply"].includes(head)) {
    const book = trimmed.replace(/^\S+\s*/u, "").trim();
    if (!book) {
      return { kind: "invalid", message: "删除参数无效。" };
    }
    return { kind: "delete-book", book };
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

  const standaloneHours = parseStandaloneHours(trimmed);
  if (standaloneHours) {
    return { kind: "preset-hours", hours: standaloneHours };
  }

  const draft = parseNaturalLanguageAppendDraft(trimmed);
  if (draft) {
    return draft;
  }

  return {
    kind: "invalid",
    message: "无法识别指令。可用：/worklog、/worklog help、/worklog month、/worklog 1.5 修复筛选回显、/worklog 今天修复筛选回显 1.5 小时",
  };
}

function parseBatchCommandPayload(raw: string): { day: string | null; raw: string } {
  const normalized = raw.replace(/^\s+/u, "");
  if (!normalized.trim()) {
    return { day: null, raw: "" };
  }

  const firstLineBreak = normalized.indexOf("\n");
  if (firstLineBreak > 0) {
    const firstLine = normalized.slice(0, firstLineBreak).trim();
    const rest = normalized.slice(firstLineBreak + 1).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstLine)) {
      return { day: firstLine, raw: rest };
    }
  }

  return { day: null, raw: normalized.trim() };
}

function parseBatchDraft(config: RuntimeConfig, raw: string, dayInput: string | null): { day: string; entries: WorklogBatchRow[]; invalidLines: string[] } {
  const day = normalizeCommentDay(dayInput);
  const normalized = normalizePastedRichTextToText(raw);
  const lines = normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries: WorklogBatchRow[] = [];
  const invalidLines: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const parsed = parseBatchEntryLine(config, line);
    if (!parsed) {
      invalidLines.push(line);
      continue;
    }

    const dedupeKey = parsed.item.toLowerCase().replace(/\s+/gu, " ").trim();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    entries.push(parsed);
  }

  return { day, entries, invalidLines };
}

function parseBatchEntryLine(config: RuntimeConfig, line: string): WorklogBatchRow | null {
  const cleaned = line
    .replace(/^[-*•]+\s*/u, "")
    .replace(/^\d+[.)、]\s*/u, "")
    .trim();
  if (!cleaned) {
    return null;
  }

  const append = parseAppendPayload(cleaned);
  if (append) {
    return { item: validateWorkItem(append.item, config), hours: append.hours };
  }

  const structured = parseStructuredAppendDraft(cleaned);
  if (structured) {
    return { item: validateWorkItem(structured.item, config), hours: structured.hours };
  }

  const trailing = cleaned.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:h|hr|hrs|小时|小時|个小时|個小時|工时)$/iu);
  if (trailing) {
    const item = cleanNaturalWorkItem(trailing[1] ?? "");
    const hours = parseDraftHours(trailing[2] ?? "");
    if (item && hours) {
      return { item: validateWorkItem(item, config), hours };
    }
  }

  return null;
}

function normalizePastedRichTextToText(raw: string): string {
  let text = raw.replace(/\r\n?/gu, "\n");
  text = text.replace(/<br\s*\/?>/giu, "\n");
  text = text.replace(/<\/(p|div|li|ul|ol|h[1-6])>/giu, "\n");
  text = text.replace(/<li[^>]*>/giu, "- ");
  text = text.replace(/<[^>]+>/gu, " ");
  text = text.replace(/&nbsp;/giu, " ");
  text = text.replace(/&lt;/giu, "<");
  text = text.replace(/&gt;/giu, ">");
  text = text.replace(/&amp;/giu, "&");
  text = text.replace(/\n{3,}/gu, "\n\n");
  return text;
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

function parseStandaloneHours(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^([0-9]+(?:\.[0-9]+)?)$/.test(trimmed)) {
    return null;
  }
  const hours = Number.parseFloat(trimmed);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

function parseNaturalLanguageAppendDraft(raw: string): Extract<WorklogAction, { kind: "append-draft" }> | null {
  const normalized = raw.trim().replace(/[，；]/gu, " ").replace(/\s+/gu, " ");
  if (!normalized) {
    return null;
  }

  const structured = parseStructuredAppendDraft(normalized);
  if (structured) {
    return structured;
  }

  const day = detectDraftDay(normalized);
  const trailing = normalized.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:h|hr|hrs|小时|小時|个小时|個小時|工时)$/iu);
  if (trailing) {
    const item = cleanNaturalWorkItem(trailing[1] ?? "");
    const hours = parseDraftHours(trailing[2] ?? "");
    if (hours && item) {
      return { kind: "append-draft", day, hours, item, sourceText: raw.trim() };
    }
  }

  const hoursMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:h|hr|hrs|小时|小時|个小时|個小時|工时)/iu);
  if (!hoursMatch) {
    return null;
  }

  const hours = parseDraftHours(hoursMatch[1] ?? "");
  if (!hours) {
    return null;
  }

  const item = cleanNaturalWorkItem(normalized.replace(hoursMatch[0], " "));
  if (!item) {
    return null;
  }

  return { kind: "append-draft", day, hours, item, sourceText: raw.trim() };
}

function parseStructuredAppendDraft(raw: string): Extract<WorklogAction, { kind: "append-draft" }> | null {
  const itemMatch = raw.match(/工作项\s*[:：]\s*([^，,；;\n]+)/u);
  const hoursMatch = raw.match(/(?:工时|时长|耗时)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/u);
  if (!itemMatch || !hoursMatch) {
    return null;
  }

  const item = cleanNaturalWorkItem(itemMatch[1] ?? "");
  const hours = parseDraftHours(hoursMatch[1] ?? "");
  if (!item || !hours) {
    return null;
  }

  return {
    kind: "append-draft",
    day: detectDraftDay(raw),
    hours,
    item,
    sourceText: raw.trim(),
  };
}

function parseDraftHours(raw: string): number | null {
  const hours = Number.parseFloat(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

function detectDraftDay(raw: string): string {
  const now = new Date();
  if (/前天/u.test(raw)) {
    return formatLocalDay(addLocalDays(now, -2));
  }
  if (/(昨天|昨日)/u.test(raw)) {
    return formatLocalDay(addLocalDays(now, -1));
  }
  return formatLocalDay(now);
}

function addLocalDays(date: Date, offset: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

function cleanNaturalWorkItem(raw: string): string {
  let text = raw.trim();
  text = text.replace(/工作项\s*[:：]\s*/gu, " ");
  text = text.replace(/(?:工时|时长|耗时)\s*[:：]\s*[0-9]+(?:\.[0-9]+)?/gu, " ");
  text = text.replace(/(?:今天|今日|昨天|昨日|前天)/gu, " ");
  text = text.replace(/^(?:请|麻烦|帮我|给我|帮忙|请帮我)?(?:补记|记录|记一下|记一条|记个|记|添加|新增|写入)(?:一条)?(?:工作日志|日志)?[:：]?\s*/u, "");
  text = text.replace(/^(?:我(?:今天|昨天|昨日|前天)?(?:在)?)(?:处理了|做了|搞了|花了|忙了)?\s*/u, "");
  text = text.replace(/^(?:把|将)\s*/u, "");
  text = text.replace(/^[,，:：;；\-\s]+/u, "");
  text = text.replace(/[，,；;。.!！?？\s]+$/u, "");
  return text.replace(/\s+/gu, " ").trim();
}

function parseEntryReference(day: string, row: string): { day: string; rowIndex: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }
  const rowIndex = Number.parseInt(row, 10);
  if (!Number.isInteger(rowIndex) || rowIndex < 1) {
    return null;
  }
  return { day, rowIndex };
}

function parseEntryReferences(day: string, rowsRaw: string): { day: string; rowIndices: number[] } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }
  const tokens = rowsRaw.split(/[\s,，、]+/u).map((part) => part.trim()).filter(Boolean);
  if (!tokens.length) {
    return null;
  }
  const rowIndices = Array.from(new Set(tokens.map((token) => Number.parseInt(token, 10)))).sort((a, b) => a - b);
  if (!rowIndices.length || rowIndices.some((index) => !Number.isInteger(index) || index < 1)) {
    return null;
  }
  return { day, rowIndices };
}

function renderMenu(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  if (changed) {
    saveState(config, state);
  }
  const currentInput = getInputState(state, channel, senderId);
  if (currentInput?.mode === "awaiting_delete_selection") {
    clearInputState(state, channel, senderId);
    saveState(config, state);
  }
  const nextInput = currentInput?.mode === "awaiting_delete_selection" ? null : currentInput;
  const bookSummary = formatBookSummary(config, state, senderId);
  const lines = [
    "工作日志",
    "",
    `入口命令：/${WORKLOG_COMMAND}`,
    `帮助命令：/${WORKLOG_COMMAND} help`,
    `当前日志本：${bookSummary}`,
    nextInput ? `输入状态：${formatInputState(nextInput)}` : "输入状态：空闲",
    "",
    "请选择操作：",
  ];

  if (channel === "telegram") {
    return replyWithButtons(lines.join("\n"), buildMenuButtons());
  }

  lines.push(
    `- /${WORKLOG_COMMAND}`,
    `- /${WORKLOG_COMMAND} help`,
    `- /${WORKLOG_COMMAND} add`,
    `- /${WORKLOG_COMMAND} today`,
    `- /${WORKLOG_COMMAND} month`,
    `- /${WORKLOG_COMMAND} recent`,
    `- /${WORKLOG_COMMAND} books`,
    `- /${WORKLOG_COMMAND} create <key> <名称>`,
    `- /${WORKLOG_COMMAND} rename <key> <新名称>`,
    `- /${WORKLOG_COMMAND} bind <sender> <book>`,
    `- /${WORKLOG_COMMAND} unbind <sender>`,
    `- /${WORKLOG_COMMAND} bindings [page] [query]`,
    `- /${WORKLOG_COMMAND} ba <book>`,
    `- /${WORKLOG_COMMAND} bd <book>`,
    `- /${WORKLOG_COMMAND} web`,
  );
  return replyText(lines.join("\n"));
}

function renderAddEntry(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  const lines = [
    "记录工作日志",
    "",
    "可选三种方式：",
    `1. 快速写入：/${WORKLOG_COMMAND} 1.5 修复筛选回显`,
    `2. 自然语言草稿：/${WORKLOG_COMMAND} 今天联调 Telegram 卡片 2 小时`,
    `3. 先选工时，再发：/${WORKLOG_COMMAND} item 修复筛选回显`,
    `4. 批量多条：/${WORKLOG_COMMAND} batch 后粘贴多行内容`,
    "",
    "自然语言会先出确认卡片；命令模式仍可直接写入。",
  ];

  if (channel === "telegram") {
    return replyWithButtons(lines.join("\n"), [
      [button("📝 直接输入内容", `/${WORKLOG_COMMAND} ai`), button("🧾 批量记录", `/${WORKLOG_COMMAND} batch`)],
      [button("⏱ 只填工时", `/${WORKLOG_COMMAND} ah`)],
      [button("⬅️ 返回主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }

  return replyText(lines.join("\n"));
}

function renderBatchPrompt(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  return replyWithOptionalButtons(channel, [
    "批量记录工作日志",
    "",
    "请发送一条多行内容：",
    `/${WORKLOG_COMMAND} batch`,
    "1. 修复筛选回显 1h",
    "2. 联调登录态 2h",
    "3. 补安装说明 0.5h",
    "",
    "也可把日期单独写在第一行：",
    `/${WORKLOG_COMMAND} batch 2026-03-09`,
    "1. 修复筛选回显 1h",
    "2. 联调登录态 2h",
    "",
    "支持粘贴富文本；系统会尽量转成逐行纯文本后再解析。",
  ].join("\n"), [
    [button("⬅️ 返回主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderDirectInput(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  const lines = [
    "记录工作日志",
    "",
    "你可以直接发送：",
    `/${WORKLOG_COMMAND} 1.5 修复筛选回显`,
    `/${WORKLOG_COMMAND} append 2 联调 Telegram 卡片`,
    `/${WORKLOG_COMMAND} 今天联调 Telegram 卡片 2 小时`,
    `/${WORKLOG_COMMAND} 工作项：联调 Telegram 卡片，工时：2`,
    `/${WORKLOG_COMMAND} batch\n1. 修复筛选回显 1h\n2. 联调登录态 2h`,
    "",
    "自然语言会先出确认卡片；命令式写法会直接落盘。",
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
    `/${WORKLOG_COMMAND} item 修复筛选回显`,
    "",
    `如果想一次写完，也可以直接用 /${WORKLOG_COMMAND} 1.5 修复筛选回显。`,
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
  saveState(config, state);

  const lines = [
    "记录工作日志",
    "",
    `已选择工时：${fmtHours(hours)}h`,
    "",
    "现在请发送：",
    `/${WORKLOG_COMMAND} item 修复筛选回显`,
    "",
    "30 分钟内有效，可随时取消。",
  ];

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("❌ 取消", `/${WORKLOG_COMMAND} x`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handlePresetItemSubmit(config: RuntimeConfig, senderId: string, rawItem: string, channel: string, logger: LoggerLike): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }

  if (!input) {
    return replyText([
      "记录工作日志",
      "",
      "当前没有待补全的输入状态。",
      `请先执行 /${WORKLOG_COMMAND} ah 选择工时，或直接用 /${WORKLOG_COMMAND} 1.5 修复筛选回显。`,
    ].join("\n"), true);
  }

  if (input.mode === "awaiting_entry_replace") {
    return replyText([
      "编辑工作记录",
      "",
      `当前正在编辑 ${input.day} 第 ${input.rowIndex} 条。`,
      `请改用：/${WORKLOG_COMMAND} replace ${fmtHours(input.currentHours)} ${input.currentItem}`,
    ].join("\n"), true);
  }

  if (input.mode === "awaiting_append_confirm") {
    return replyText([
      "记录工作日志",
      "",
      "当前有一条待确认草稿。",
      `请先执行 /${WORKLOG_COMMAND} confirm 写入，或 /${WORKLOG_COMMAND} modify 重新改草稿。`,
    ].join("\n"), true);
  }

  if (input.mode === "awaiting_batch_confirm") {
    return replyText([
      "工作日志",
      "",
      "当前有一组待确认的批量草稿。",
      `请先执行 /${WORKLOG_COMMAND} batch-save 写入，或 /${WORKLOG_COMMAND} x 取消。`,
    ].join("\n"), true);
  }

  if (input.mode === "awaiting_comment_confirm") {
    return replyText([
      "工作日志",
      "",
      "当前有一条待确认锐评。",
      `请先执行 /${WORKLOG_COMMAND} comment-ok 保存，或 /${WORKLOG_COMMAND} x 取消。`,
    ].join("\n"), true);
  }

  if (input.mode === "awaiting_delete_selection") {
    return replyText([
      "工作日志",
      "",
      "当前正在批量删除选择模式。",
      `请先点卡片上的确认删除，或执行 /${WORKLOG_COMMAND} t 返回今日记录。`,
    ].join("\n"), true);
  }

  if (!Number.isFinite(input.presetHours)) {
    return replyText([
      "记录工作日志",
      "",
      "当前工时状态无效。",
      `请重新执行 /${WORKLOG_COMMAND} ah 选择工时。`,
    ].join("\n"), true);
  }

  const item = validateWorkItem(rawItem, config);
  const reply = appendForSender(config, senderId, item, input.presetHours, logger);
  clearInputState(state, channel, senderId);
  saveState(config, state);
  return replyWithOptionalButtons(channel, reply, buildSuccessButtons(config));
}

function renderAppendDraftConfirm(
  config: RuntimeConfig,
  senderId: string,
  day: string,
  hours: number,
  rawItem: string,
  sourceText: string,
  channel: string,
): ReplyPayload {
  const item = validateWorkItem(rawItem, config);
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });

  const state = loadState(config);
  setInputState(state, channel, senderId, {
    mode: "awaiting_append_confirm",
    day,
    hours,
    item,
    sourceText,
    createdAt: Date.now(),
    expiresAt: Date.now() + INPUT_STATE_TTL_MS,
  });
  saveState(config, state);

  const books = getEffectiveBooks(config, state);
  const bookName = books[resolved.key]?.name ?? "";
  const bookLabel = bookName ? `${resolved.key}（${bookName}）` : resolved.key;
  const lines = [
    "待确认工作日志",
    "",
    `日志本：${bookLabel}`,
    `日期：${day}`,
    `工作项：${item}`,
    `工时：${fmtHours(hours)}h`,
    sourceText.trim() && sourceText.trim() !== `${hours} ${item}` ? `原始输入：${sourceText.trim()}` : "",
    "",
    "确认后写入；修改会保留草稿并等你重新输入。",
  ].filter(Boolean);

  return replyWithOptionalButtons(channel, lines.join("\n"), buildAppendDraftButtons(config, day));
}

function renderRewriteAppendDraft(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }

  if (!input || input.mode !== "awaiting_append_confirm") {
    return replyWithOptionalButtons(channel, [
      "工作日志",
      "",
      "当前没有待修改的草稿。",
      `可直接发送：/${WORKLOG_COMMAND} 今天测试 3 小时`,
    ].join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  return replyWithOptionalButtons(channel, [
    "修改工作日志草稿",
    "",
    `当前草稿：${fmtHours(input.hours)}h ${input.item}`,
    `日期：${input.day}`,
    "",
    "请重新发送新的内容，旧草稿会被覆盖：",
    `/${WORKLOG_COMMAND} 今天联调 Telegram 卡片 2 小时`,
    `/${WORKLOG_COMMAND} 工作项：联调 Telegram 卡片，工时：2`,
  ].join("\n"), [
    [button("❌ 取消", `/${WORKLOG_COMMAND} x`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}


function renderBatchDraftConfirm(config: RuntimeConfig, senderId: string, dayInput: string | null, raw: string, channel: string): ReplyPayload {
  const parsed = parseBatchDraft(config, raw, dayInput);
  if (!parsed.entries.length) {
    return replyWithOptionalButtons(channel, [
      "批量记录工作日志",
      "",
      `日期：${parsed.day}`,
      "没有解析出可写入的工作项。",
      "示例：1. 修复筛选回显 1h",
      parsed.invalidLines.length ? "未识别行：" : "",
      ...parsed.invalidLines.slice(0, 6).map((line, index) => `${index + 1}. ${line}`),
    ].filter(Boolean).join("\n"), [
      [button("🧾 重新输入", `/${WORKLOG_COMMAND} batch`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const state = loadState(config);
  setInputState(state, channel, senderId, {
    mode: "awaiting_batch_confirm",
    day: parsed.day,
    entries: parsed.entries,
    invalidLines: parsed.invalidLines,
    sourceText: raw,
    createdAt: Date.now(),
    expiresAt: Date.now() + INPUT_STATE_TTL_MS,
  });
  saveState(config, state);

  const totalHours = parsed.entries.reduce((sum, entry) => sum + entry.hours, 0);
  const lines = [
    "待确认批量工作日志",
    "",
    `日志本：${resolved.key}`,
    `日期：${parsed.day}`,
    `条数：${parsed.entries.length}`,
    `总工时：${fmtHours(totalHours)}h`,
    "",
    ...parsed.entries.slice(0, 12).map((entry, index) => `${index + 1}. ${entry.item} · ${fmtHours(entry.hours)}h`),
  ];
  if (parsed.entries.length > 12) {
    lines.push(`……还有 ${parsed.entries.length - 12} 条未展开`);
  }
  if (parsed.invalidLines.length) {
    lines.push("", `未识别 ${parsed.invalidLines.length} 行，确认时会自动忽略：`);
    lines.push(...parsed.invalidLines.slice(0, 5).map((line, index) => `${index + 1}. ${line}`));
  }

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("✅ 全部写入", `/${WORKLOG_COMMAND} batch-save`)],
    [button("🧾 重新输入", `/${WORKLOG_COMMAND} batch`), button("❌ 取消", `/${WORKLOG_COMMAND} x`)],
  ]);
}

function handleConfirmBatchDraft(config: RuntimeConfig, senderId: string, channel: string, logger: LoggerLike): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }

  if (!input || input.mode !== "awaiting_batch_confirm") {
    return replyWithOptionalButtons(channel, [
      "工作日志",
      "",
      "当前没有待确认的批量草稿。",
      `可直接发送：/${WORKLOG_COMMAND} batch 后粘贴多行内容。`,
    ].join("\n"), [
      [button("🧾 批量记录", `/${WORKLOG_COMMAND} batch`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const reply = appendBatchForSender(config, senderId, input.day, input.entries, input.invalidLines, logger);
  clearInputState(state, channel, senderId);
  saveState(config, state);
  return replyWithOptionalButtons(channel, reply, buildSuccessButtons(config, input.day));
}

function renderCommentPrompt(config: RuntimeConfig, senderId: string, dayInput: string | null, channel: string): ReplyPayload {
  if (!config.commentPolicy.enabled) {
    return replyText("工作日志\n\n当前配置未启用锐评能力。", true);
  }

  const day = normalizeCommentDay(dayInput);
  if (!config.commentPolicy.allowSameDayComment && day === formatLocalDay(new Date())) {
    return replyWithOptionalButtons(channel, [
      "补写锐评",
      "",
      `日期：${day}`,
      "当前配置禁止给今天补锐评。",
      "如需允许，可把 commentPolicy.allowSameDayComment 设为 true。",
    ].join("\n"), [
      [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const resolved = resolveBook({ config, senderId });
  enforceReadScope({ config, senderId, key: resolved.key });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);

  try {
    const doc = loadMonthDocument({ config, bookPath, month: day.slice(0, 7) });
    const section = doc.sections.find((entry) => entry.day === day) ?? null;
    if (!section) {
      return replyWithOptionalButtons(channel, [
        "补写锐评",
        "",
        `日志本：${resolved.key}`,
        `日期：${day}`,
        "当天还没有工作项，暂时不能补锐评。",
      ].join("\n"), [
        [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
      ], true);
    }

    const lines = [
      section.comment ? "修改锐评" : "补写锐评",
      "",
      `日志本：${resolved.key}`,
      `日期：${day}`,
      section.comment ? `${config.commentPolicy.title}：${section.comment}` : "当前还没有锐评。",
      "",
      `发送示例：/${WORKLOG_COMMAND} comment ${day} 这天主要是在清理遗留问题。`,
      "锐评应简洁、具体、可复盘；不要把它混进工作项里。",
    ];

    const buttons: TelegramInlineKeyboardButton[][] = [];
    if (getAiAvailability(config).ok) {
      buttons.push([button("🧠 AI 检测锐评", `/${WORKLOG_COMMAND} ai-comment ${day}`)]);
    }
    buttons.push([button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);

    return replyWithOptionalButtons(channel, lines.join("\n"), buttons);
  } catch {
    return replyWithOptionalButtons(channel, [
      "补写锐评",
      "",
      `日志本：${resolved.key}`,
      `日期：${day}`,
      "当前月份还没有日志文件，无法补锐评。",
    ].join("\n"), [
      [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }
}

function handleCommentSave(config: RuntimeConfig, senderId: string, dayInput: string | null, rawComment: string, channel: string, logger: LoggerLike): ReplyPayload {
  if (!config.commentPolicy.enabled) {
    return replyText("工作日志\n\n当前配置未启用锐评能力。", true);
  }

  const day = normalizeCommentDay(dayInput);
  if (!config.commentPolicy.allowSameDayComment && day === formatLocalDay(new Date())) {
    return replyText(`工作日志\n\n当前配置禁止给今天补锐评：${day}`, true);
  }

  const comment = validateComment(rawComment, config);
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const result = upsertDayComment({ config, bookPath, day, comment });
  logger.info(`[worklog] comment sender=${senderId} book=${resolved.key} day=${day}`);

  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (input && input.mode === "awaiting_comment_confirm") {
    clearInputState(state, channel, senderId);
  }
  if (changed || (input && input.mode === "awaiting_comment_confirm")) {
    saveState(config, state);
  }

  return replyWithOptionalButtons(channel, [
    "已保存锐评",
    "",
    `日志本：${resolved.key}`,
    `日期：${day}`,
    `${config.commentPolicy.title}：${comment}`,
    `今日累计：${fmtHours(Number(result.dayTotalHours))}h / ${String(result.dayItemCount)} 条`,
    `本月累计：${fmtHours(Number(result.monthTotalHours))}h`,
  ].join("\n"), buildSuccessButtons(config, day));
}

function handleConfirmCommentDraft(config: RuntimeConfig, senderId: string, channel: string, logger: LoggerLike): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }

  if (!input || input.mode !== "awaiting_comment_confirm") {
    return replyWithOptionalButtons(channel, [
      "工作日志",
      "",
      "当前没有待确认的锐评草稿。",
      `可直接发送：/${WORKLOG_COMMAND} comment 2026-03-08 这天主要在清理遗留问题。`,
    ].join("\n"), [
      [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  return handleCommentSave(config, senderId, input.day, input.comment, channel, logger);
}

async function handleAiPolishDraft(config: RuntimeConfig, senderId: string, channel: string): Promise<ReplyPayload> {
  const availability = getAiAvailability(config);
  if (!availability.ok) {
    return replyWithOptionalButtons(channel, `工作日志

${availability.reason}`, [
      [button("✏️ 修改草稿", `/${WORKLOG_COMMAND} modify`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }

  if (!input) {
    return replyWithOptionalButtons(channel, [
      "工作日志",
      "",
      "当前没有待润色的草稿。",
      `可先发送：/${WORKLOG_COMMAND} 今天联调 Telegram 卡片 2 小时`,
      `或 /${WORKLOG_COMMAND} batch 后粘贴多行内容。`,
    ].join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`), button("🧾 批量记录", `/${WORKLOG_COMMAND} batch`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  if (input.mode === "awaiting_batch_confirm") {
    const polished = await polishWorklogBatch({
      config,
      day: input.day,
      entries: input.entries,
      sourceText: input.sourceText,
    });
    const entries = input.entries.map((entry, index) => ({
      ...entry,
      item: validateWorkItem(polished.items[index] ?? entry.item, config),
    }));
    setInputState(state, channel, senderId, {
      ...input,
      entries,
      expiresAt: Date.now() + INPUT_STATE_TTL_MS,
    });
    saveState(config, state);

    return replyWithOptionalButtons(channel, [
      "AI 已润色整批工作项",
      "",
      `日期：${input.day}`,
      `条数：${entries.length}`,
      `说明：${polished.reason}`,
      "",
      ...entries.slice(0, 12).map((entry, index) => `${index + 1}. ${entry.item} · ${fmtHours(entry.hours)}h`),
      entries.length > 12 ? `……还有 ${entries.length - 12} 条未展开` : "",
      "",
      "确认后会按当前顺序整批写入。",
    ].filter(Boolean).join("\n"), [
      [button("✅ 全部写入", `/${WORKLOG_COMMAND} batch-save`)],
      [button("🧾 重新输入", `/${WORKLOG_COMMAND} batch`), button("❌ 取消", `/${WORKLOG_COMMAND} x`)],
    ]);
  }

  if (input.mode !== "awaiting_append_confirm") {
    return replyWithOptionalButtons(channel, [
      "工作日志",
      "",
      "当前没有可润色的工作日志草稿。",
      `可先发送：/${WORKLOG_COMMAND} 今天联调 Telegram 卡片 2 小时`,
    ].join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const polished = await polishWorklogDraft({
    config,
    day: input.day,
    hours: input.hours,
    item: input.item,
    sourceText: input.sourceText,
  });
  const item = validateWorkItem(polished.item, config);
  setInputState(state, channel, senderId, {
    ...input,
    item,
    expiresAt: Date.now() + INPUT_STATE_TTL_MS,
  });
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "AI 已润色工作项",
    "",
    `日期：${input.day}`,
    `工时：${fmtHours(input.hours)}h`,
    `工作项：${item}`,
    `说明：${polished.reason}`,
    "",
    "确认后写入；你也可以继续手动修改。",
  ].join("\n"), buildAppendDraftButtons(config, input.day));
}

async function handleAiDetectComment(config: RuntimeConfig, senderId: string, dayInput: string | null, channel: string): Promise<ReplyPayload> {
  if (!config.commentPolicy.enabled) {
    return replyText("工作日志\n\n当前配置未启用锐评能力。", true);
  }

  const availability = getAiAvailability(config);
  if (!availability.ok) {
    return replyWithOptionalButtons(channel, `工作日志\n\n${availability.reason}`, [
      [button("💬 补锐评", `/${WORKLOG_COMMAND} c ${normalizeCommentDay(dayInput)}`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const day = normalizeCommentDay(dayInput);
  if (!config.commentPolicy.allowSameDayComment && day === formatLocalDay(new Date())) {
    return replyText(`工作日志\n\n当前配置禁止给今天补锐评：${day}`, true);
  }

  const resolved = resolveBook({ config, senderId });
  enforceReadScope({ config, senderId, key: resolved.key });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);

  let section: ReturnType<typeof loadMonthDocument>["sections"][number] | null = null;
  try {
    const doc = loadMonthDocument({ config, bookPath, month: day.slice(0, 7) });
    section = doc.sections.find((entry) => entry.day === day) ?? null;
  } catch {
    section = null;
  }

  if (!section || !section.rows.length) {
    return replyWithOptionalButtons(channel, [
      "AI 检测锐评",
      "",
      `日志本：${resolved.key}`,
      `日期：${day}`,
      "当天还没有已落盘的工作项，暂时无法检测锐评。",
    ].join("\n"), [
      [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const suggestion = await suggestWorklogComment({
    config,
    day,
    rows: section.rows,
    existingComment: section.comment,
  });

  if (!suggestion.shouldAdd || !suggestion.comment) {
    return replyWithOptionalButtons(channel, [
      "AI 检测锐评",
      "",
      `日志本：${resolved.key}`,
      `日期：${day}`,
      "结论：当前不建议补锐评。",
      `原因：${suggestion.reason}`,
    ].join("\n"), [
      [button("💬 手动补锐评", `/${WORKLOG_COMMAND} c ${day}`), button("📋 今日记录", `/${WORKLOG_COMMAND} t`)],
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }

  const comment = validateComment(suggestion.comment, config);
  const state = loadState(config);
  purgeExpiredInputStates(state, Date.now());
  setInputState(state, channel, senderId, {
    mode: "awaiting_comment_confirm",
    day,
    comment,
    source: "ai",
    createdAt: Date.now(),
    expiresAt: Date.now() + INPUT_STATE_TTL_MS,
  });
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "待确认锐评",
    "",
    `日志本：${resolved.key}`,
    `日期：${day}`,
    `${config.commentPolicy.title}：${comment}`,
    `说明：${suggestion.reason}`,
    "",
    "确认后会覆盖当天锐评；你也可以手动改写。",
  ].join("\n"), [
    [button("✅ 保存锐评", `/${WORKLOG_COMMAND} comment-ok`), button("✏️ 手动改写", `/${WORKLOG_COMMAND} c ${day}`)],
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function normalizeCommentDay(dayInput: string | null): string {
  const trimmed = dayInput?.trim() ?? "";
  return trimmed || formatLocalDay(new Date());
}

function handleConfirmAppendDraft(config: RuntimeConfig, senderId: string, channel: string, logger: LoggerLike): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }

  if (!input || input.mode !== "awaiting_append_confirm") {
    return replyWithOptionalButtons(channel, [
      "工作日志",
      "",
      "当前没有待确认的草稿。",
      `可直接发送：/${WORKLOG_COMMAND} 今天测试 3 小时`,
    ].join("\n"), [
      [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const reply = appendForSender(config, senderId, input.item, input.hours, logger, input.day);
  clearInputState(state, channel, senderId);
  saveState(config, state);
  return replyWithOptionalButtons(channel, reply, buildSuccessButtons(config, input.day));
}

function handleAppend(config: RuntimeConfig, senderId: string, hours: number, rawItem: string, channel: string, logger: LoggerLike): ReplyPayload {
  clearActiveInput(config, senderId, channel);
  const item = validateWorkItem(rawItem, config);
  const reply = appendForSender(config, senderId, item, hours, logger);
  return replyWithOptionalButtons(channel, reply, buildSuccessButtons(config));
}

function appendBatchForSender(
  config: RuntimeConfig,
  senderId: string,
  day: string,
  entries: WorklogBatchRow[],
  invalidLines: string[],
  logger: LoggerLike,
): string {
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);

  let added = 0;
  let skipped = 0;
  let dayTotalHours = 0;
  let dayItemCount = 0;
  let monthTotalHours = 0;

  for (const entry of entries) {
    const result = appendWorklogEntry({ config, bookPath, day, item: entry.item, hours: entry.hours }) as {
      status?: string;
      dayTotalHours?: number;
      dayItemCount?: number;
      monthTotalHours?: number;
    };
    if (result.status === "skipped") {
      skipped += 1;
    } else {
      added += 1;
    }
    dayTotalHours = Number(result.dayTotalHours ?? dayTotalHours);
    dayItemCount = Number(result.dayItemCount ?? dayItemCount);
    monthTotalHours = Number(result.monthTotalHours ?? monthTotalHours);
  }

  logger.info(`[worklog] batch-append sender=${senderId} book=${resolved.key} day=${day} count=${entries.length} added=${added} skipped=${skipped}`);

  return [
    "已批量记录工作日志",
    "",
    `日志本：${resolved.key}`,
    `日期：${day}`,
    `输入条数：${entries.length + invalidLines.length}`,
    `成功写入：${added}`,
    `重复跳过：${skipped}`,
    invalidLines.length ? `未识别忽略：${invalidLines.length}` : "",
    `今日累计：${fmtHours(dayTotalHours)}h / ${dayItemCount} 条`,
    `本月累计：${fmtHours(monthTotalHours)}h`,
  ].filter(Boolean).join("\n");
}

function appendForSender(config: RuntimeConfig, senderId: string, item: string, hours: number, logger: LoggerLike, day = formatLocalDay(new Date())): string {
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
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

function handleEditEntryStart(config: RuntimeConfig, senderId: string, day: string, rowIndex: number, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const entry = resolveEntryRow(config, senderId, day, rowIndex);
  const state = loadState(config);
  const now = Date.now();
  purgeExpiredInputStates(state, now);
  setInputState(state, channel, senderId, {
    mode: "awaiting_entry_replace",
    day,
    rowIndex,
    currentHours: entry.row.hours,
    currentItem: entry.row.item,
    createdAt: now,
    expiresAt: now + INPUT_STATE_TTL_MS,
  });
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "编辑工作记录",
    "",
    `日志本：${entry.bookKey}`,
    `日期：${day}`,
    `序号：${rowIndex}`,
    `当前内容：${entry.row.item}`,
    `当前工时：${fmtHours(entry.row.hours)}h`,
    "",
    `下一步：/${WORKLOG_COMMAND} replace <工时> <新内容>`,
    `示例：/${WORKLOG_COMMAND} replace ${fmtHours(entry.row.hours)} ${entry.row.item}`,
  ].join("\n"), [
    [button("🗑 删除这条", `/${WORKLOG_COMMAND} dc ${day} ${rowIndex}`)],
    [button("📋 返回今日", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleReplaceEntry(config: RuntimeConfig, senderId: string, hours: number, rawItem: string, channel: string, logger: LoggerLike): ReplyPayload {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }

  if (!input || input.mode !== "awaiting_entry_replace") {
    return replyText([
      "编辑工作记录",
      "",
      "当前不在可替换状态。",
      `请先从 /${WORKLOG_COMMAND} today 进入编辑。`,
    ].join("\n"), true);
  }

  const item = validateWorkItem(rawItem, config);
  const reply = replaceEntryForSender(config, senderId, input.day, input.rowIndex, item, hours, logger);
  clearInputState(state, channel, senderId);
  saveState(config, state);
  return replyWithOptionalButtons(channel, reply, [
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
    [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderDeleteEntryConfirm(config: RuntimeConfig, senderId: string, day: string, rowIndex: number, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const entry = resolveEntryRow(config, senderId, day, rowIndex);
  return replyWithOptionalButtons(channel, [
    "确认删除工作记录",
    "",
    `日志本：${entry.bookKey}`,
    `日期：${day}`,
    `序号：${rowIndex}`,
    `工作项：${entry.row.item}`,
    `工时：${fmtHours(entry.row.hours)}h`,
    "",
    "确认后会直接落盘删除。",
  ].join("\n"), [
    [button("🗑 确认删除", `/${WORKLOG_COMMAND} dd ${day} ${rowIndex}`)],
    [button("✏️ 改为编辑", `/${WORKLOG_COMMAND} e ${day} ${rowIndex}`)],
    [button("📋 返回今日", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderDeleteEntriesConfirm(config: RuntimeConfig, senderId: string, day: string, rowIndices: number[], channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const entries = resolveEntryRows(config, senderId, day, rowIndices);
  const lines = [
    "确认批量删除工作记录",
    "",
    `日志本：${entries.bookKey}`,
    `日期：${day}`,
    `序号：${rowIndices.join(", ")}`,
    ...entries.rows.map((row, index) => `${index + 1}. 第 ${rowIndices[index]} 条：${row.item} · ${fmtHours(row.hours)}h`),
    "",
    "确认后会直接落盘删除。",
  ];

  const hasDeleteSelection = Boolean(readDeleteSelectionInput(config, senderId, channel, day));
  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("🗑 确认批量删除", `/${WORKLOG_COMMAND} dd ${day} ${rowIndices.join(",")}`)],
    hasDeleteSelection
      ? [button("🗂 返回多选", `/${WORKLOG_COMMAND} dm ${day}`), button("📋 返回今日", `/${WORKLOG_COMMAND} t`)]
      : [button("📋 返回今日", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    hasDeleteSelection ? [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)] : [],
  ].filter((row) => row.length > 0));
}

function handleDeleteEntries(config: RuntimeConfig, senderId: string, day: string, rowIndices: number[], channel: string, logger: LoggerLike): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const entries = resolveEntryRows(config, senderId, day, rowIndices);
  const result = deleteEntriesForSender(config, senderId, day, rowIndices, logger);
  clearActiveInput(config, senderId, channel);

  return replyWithOptionalButtons(channel, [
    "已批量删除工作记录",
    "",
    `日志本：${entries.bookKey}`,
    `日期：${day}`,
    `删除序号：${rowIndices.join(", ")}`,
    `删除条数：${entries.rows.length}`,
    `今日剩余：${fmtHours(Number(result.dayTotalHours))}h / ${String(result.dayItemCount)} 条`,
    `本月累计：${fmtHours(Number(result.monthTotalHours))}h`,
  ].join("\n"), [
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
    [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleDeleteSelectionStart(config: RuntimeConfig, senderId: string, day: string, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const existing = readDeleteSelectionInput(config, senderId, channel, day);
  persistDeleteSelection(config, senderId, channel, day, existing?.selectedRowIndices ?? []);
  return renderDeleteSelection(config, senderId, day, channel);
}

function handleDeleteSelectionToggle(config: RuntimeConfig, senderId: string, day: string, rowIndex: number, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const section = resolveDaySection(config, senderId, day);
  if (rowIndex > section.rows.length) {
    throw new Error(`记录序号不存在：${rowIndex}`);
  }

  const next = new Set(readDeleteSelectionInput(config, senderId, channel, day)?.selectedRowIndices ?? []);
  if (next.has(rowIndex)) {
    next.delete(rowIndex);
  } else {
    next.add(rowIndex);
  }
  persistDeleteSelection(config, senderId, channel, day, [...next]);
  return renderDeleteSelection(config, senderId, day, channel);
}

function handleDeleteSelectionClear(config: RuntimeConfig, senderId: string, day: string, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  persistDeleteSelection(config, senderId, channel, day, []);
  return renderDeleteSelection(config, senderId, day, channel);
}

function handleDeleteSelectionConfirm(config: RuntimeConfig, senderId: string, day: string, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const selectedRowIndices = readDeleteSelectionInput(config, senderId, channel, day)?.selectedRowIndices ?? [];
  if (!selectedRowIndices.length) {
    return renderDeleteSelection(config, senderId, day, channel, "请先至少勾选一条工作项。", true);
  }
  return renderDeleteEntriesConfirm(config, senderId, day, selectedRowIndices, channel);
}
function handleDeleteEntry(config: RuntimeConfig, senderId: string, day: string, rowIndex: number, channel: string, logger: LoggerLike): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const entry = resolveEntryRow(config, senderId, day, rowIndex);
  const result = deleteEntryForSender(config, senderId, day, rowIndex, logger);
  clearActiveInput(config, senderId, channel);

  return replyWithOptionalButtons(channel, [
    "已删除工作记录",
    "",
    `日志本：${entry.bookKey}`,
    `日期：${day}`,
    `序号：${rowIndex}`,
    `工作项：${entry.row.item}`,
    `工时：${fmtHours(entry.row.hours)}h`,
    `今日剩余：${fmtHours(Number(result.dayTotalHours))}h / ${String(result.dayItemCount)} 条`,
    `本月累计：${fmtHours(Number(result.monthTotalHours))}h`,
  ].join("\n"), [
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
    [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function replaceEntryForSender(config: RuntimeConfig, senderId: string, day: string, rowIndex: number, item: string, hours: number, logger: LoggerLike): string {
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const result = replaceWorklogEntry({ config, bookPath, day, rowIndex, item, hours });
  logger.info(`[worklog] replace sender=${senderId} book=${resolved.key} day=${day} row=${rowIndex} hours=${hours}`);

  return [
    "已更新工作记录",
    "",
    `日志本：${resolved.key}`,
    `日期：${day}`,
    `序号：${rowIndex}`,
    `工作项：${item}`,
    `工时：${fmtHours(hours)}h`,
    `今日累计：${fmtHours(Number(result.dayTotalHours))}h / ${String(result.dayItemCount)} 条`,
    `本月累计：${fmtHours(Number(result.monthTotalHours))}h`,
  ].join("\n");
}

function deleteEntryForSender(config: RuntimeConfig, senderId: string, day: string, rowIndex: number, logger: LoggerLike): Record<string, unknown> {
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const result = deleteWorklogEntry({ config, bookPath, day, rowIndex });
  logger.info(`[worklog] delete sender=${senderId} book=${resolved.key} day=${day} row=${rowIndex}`);
  return result;
}

function deleteEntriesForSender(config: RuntimeConfig, senderId: string, day: string, rowIndices: number[], logger: LoggerLike): Record<string, unknown> {
  const resolved = resolveBook({ config, senderId });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const result = deleteWorklogEntries({ config, bookPath, day, rowIndices });
  logger.info(`[worklog] delete-batch sender=${senderId} book=${resolved.key} day=${day} rows=${rowIndices.join(",")}`);
  return result;
}

function resolveEntryRow(config: RuntimeConfig, senderId: string, day: string, rowIndex: number): {
  bookKey: string;
  row: { item: string; hours: number };
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`日期格式不正确：${day}`);
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 1) {
    throw new Error(`记录序号无效：${rowIndex}`);
  }

  const resolved = resolveBook({ config, senderId });
  enforceReadScope({ config, senderId, key: resolved.key });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const doc = loadMonthDocument({ config, bookPath, month: day.slice(0, 7) });
  const section = doc.sections.find((entry) => entry.day === day);
  if (!section) {
    throw new Error(`指定日期不存在：${day}`);
  }
  const row = section.rows[rowIndex - 1];
  if (!row) {
    throw new Error(`记录序号不存在：${rowIndex}`);
  }

  return {
    bookKey: resolved.key,
    row,
  };
}

function resolveEntryRows(config: RuntimeConfig, senderId: string, day: string, rowIndices: number[]): {
  bookKey: string;
  rows: Array<{ item: string; hours: number }>;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`日期格式不正确：${day}`);
  }
  const uniqueIndices = Array.from(new Set(rowIndices)).sort((a, b) => a - b);
  if (!uniqueIndices.length || uniqueIndices.some((rowIndex) => !Number.isInteger(rowIndex) || rowIndex < 1)) {
    throw new Error("记录序号无效。");
  }

  const section = resolveDaySection(config, senderId, day);
  const rows = uniqueIndices.map((rowIndex) => {
    const row = section.rows[rowIndex - 1];
    if (!row) {
      throw new Error(`记录序号不存在：${rowIndex}`);
    }
    return row;
  });

  return { bookKey: section.bookKey, rows };
}

function resolveDaySection(config: RuntimeConfig, senderId: string, day: string): {
  bookKey: string;
  rows: Array<{ item: string; hours: number }>;
  comment: string | null;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`日期格式不正确：${day}`);
  }

  const resolved = resolveBook({ config, senderId });
  enforceReadScope({ config, senderId, key: resolved.key });
  enforceWriteScope({ config, senderId, key: resolved.key });
  const bookPath = locateBookPath(config, resolved.key);
  const doc = loadMonthDocument({ config, bookPath, month: day.slice(0, 7) });
  const section = doc.sections.find((entry) => entry.day === day);
  if (!section) {
    throw new Error(`指定日期不存在：${day}`);
  }

  return {
    bookKey: resolved.key,
    rows: section.rows,
    comment: section.comment ?? null,
  };
}

function readDeleteSelectionInput(config: RuntimeConfig, senderId: string, channel: string, day: string): Extract<WorklogInputState, { mode: "awaiting_delete_selection" }> | null {
  const state = loadState(config);
  const changed = purgeExpiredInputStates(state, Date.now());
  const input = getInputState(state, channel, senderId);
  if (changed) {
    saveState(config, state);
  }
  if (!input || input.mode !== "awaiting_delete_selection" || input.day !== day) {
    return null;
  }
  return input;
}

function persistDeleteSelection(config: RuntimeConfig, senderId: string, channel: string, day: string, rowIndices: number[]): void {
  const state = loadState(config);
  setInputState(state, channel, senderId, {
    mode: "awaiting_delete_selection",
    day,
    selectedRowIndices: Array.from(new Set(rowIndices))
      .filter((rowIndex) => Number.isInteger(rowIndex) && rowIndex >= 1)
      .sort((a, b) => a - b),
    createdAt: Date.now(),
    expiresAt: Date.now() + INPUT_STATE_TTL_MS,
  });
  saveState(config, state);
}

function buildDeleteSelectionButtons(day: string, rowCount: number, selected: Set<number>): TelegramInlineKeyboardButton[][] {
  const buttons: TelegramInlineKeyboardButton[][] = [];
  const toggleButtons = Array.from({ length: rowCount }, (_, index) => {
    const rowIndex = index + 1;
    return button(selected.has(rowIndex) ? `✅ ${rowIndex}` : `▫️ ${rowIndex}`, `/${WORKLOG_COMMAND} dt ${day} ${rowIndex}`);
  });

  for (let index = 0; index < toggleButtons.length; index += 4) {
    buttons.push(toggleButtons.slice(index, index + 4));
  }

  const actionRow: TelegramInlineKeyboardButton[] = [button(`🗑 确认删除${selected.size ? `（${selected.size}）` : ""}`, `/${WORKLOG_COMMAND} dok ${day}`)];
  if (selected.size) {
    actionRow.push(button("🔄 清空", `/${WORKLOG_COMMAND} dclr ${day}`));
  }
  buttons.push(actionRow);
  buttons.push([button("📋 返回今日", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);
  return buttons;
}

function renderDeleteSelection(
  config: RuntimeConfig,
  senderId: string,
  day: string,
  channel: string,
  hintMessage?: string,
  isError = false,
): ReplyPayload {
  const section = resolveDaySection(config, senderId, day);
  if (section.rows.length < 2) {
    clearActiveInput(config, senderId, channel);
    return replyWithOptionalButtons(channel, [
      "批量删除工作记录",
      "",
      `日志本：${section.bookKey}`,
      `日期：${day}`,
      "当天不足两条记录，直接用单条删除即可。",
    ].join("\n"), [
      [button("📋 返回今日", `/${WORKLOG_COMMAND} t`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ], true);
  }

  const selected = new Set((readDeleteSelectionInput(config, senderId, channel, day)?.selectedRowIndices ?? []).filter((rowIndex) => rowIndex >= 1 && rowIndex <= section.rows.length));
  persistDeleteSelection(config, senderId, channel, day, [...selected]);

  const lines = [
    "批量删除工作记录",
    "",
    `日志本：${section.bookKey}`,
    `日期：${day}`,
    `总条数：${section.rows.length}`,
    `已选序号：${selected.size ? [...selected].join(", ") : "暂无"}`,
    "",
    hintMessage ?? "点下面的序号按钮可多选，再点确认删除。",
    "",
    ...section.rows.map((row, index) => `${selected.has(index + 1) ? "✅" : "▫️"} ${index + 1}. ${row.item} · ${fmtHours(row.hours)}h`),
  ];
  if (channel !== "telegram") {
    lines.push("", `也可直接输入：/${WORKLOG_COMMAND} delete ${day} 1,2,3`);
  }

  return replyWithOptionalButtons(channel, lines.join("\n"), buildDeleteSelectionButtons(day, section.rows.length, selected), isError);
}
function renderToday(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  clearDeleteSelectionInput(config, senderId, channel);
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

    if (channel !== "telegram") {
      lines.push(
        "",
        `编辑示例：/${WORKLOG_COMMAND} edit ${day} 1`,
        `删除示例：/${WORKLOG_COMMAND} delete ${day} 1`,
      );
    } else if (section.rows.length > 5) {
      lines.push("", "快捷按钮仅展示前 5 条，其余请用命令编辑或删除。");
    }

    const buttons: TelegramInlineKeyboardButton[][] = [
      [button("➕ 再记一条", `/${WORKLOG_COMMAND} a`)],
    ];
    if (channel === "telegram" && section.rows.length > 1) {
      buttons.push([button("🗂 批量删除", `/${WORKLOG_COMMAND} dm ${day}`)]);
    }
    if (config.commentPolicy.enabled && config.commentPolicy.allowSameDayComment) {
      const commentLabel = section.comment ? "✏️ 改锐评" : "💬 补锐评";
      const commentRow: TelegramInlineKeyboardButton[] = [button(commentLabel, `/${WORKLOG_COMMAND} c ${day}`)];
      if (getAiAvailability(config).ok) {
        commentRow.push(button("🧠 检测锐评", `/${WORKLOG_COMMAND} ai-comment ${day}`));
      }
      buttons.push(commentRow);
    }
    if (channel === "telegram") {
      for (const [index] of section.rows.slice(0, 5).entries()) {
        const currentRow = index + 1;
        buttons.push([
          button(`✏️ ${currentRow}`, `/${WORKLOG_COMMAND} e ${day} ${currentRow}`),
          button(`🗑 ${currentRow}`, `/${WORKLOG_COMMAND} dc ${day} ${currentRow}`),
        ]);
      }
    }
    buttons.push([button("📊 本月统计", `/${WORKLOG_COMMAND} s`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);

    return replyWithOptionalButtons(channel, lines.join("\n"), buttons);
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
  const selectedBook = isSenderRouted ? boundBook : currentBook;

  const effectiveBindings = getEffectiveBindings(config, state);
  const lines = [
    "日志本面板",
    "",
    `路由模式：${isSenderRouted ? "按发送者绑定" : "全局当前日志本"}`,
    isSenderRouted ? `当前绑定：${boundBook ?? "未绑定"}` : `当前日志本：${currentBook || "未设置"}`,
    `可用日志本：${Object.keys(books).length}`,
    "",
    ...Object.entries(books).slice(0, 12).map(([key, book]) => {
      const mark = key === selectedBook ? "✅" : "·";
      return `${mark} ${key} · ${book.name}`;
    }),
  ];

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (isAdmin) {
    buttons.push([button("➕ 新建日志本", `/${WORKLOG_COMMAND} bc`)]);
    buttons.push([button("🔗 绑定管理", `/${WORKLOG_COMMAND} bb`), button("🧾 绑定列表", `/${WORKLOG_COMMAND} bl`)]);
    if (selectedBook) {
      buttons.push([button("✏️ 重命名当前", `/${WORKLOG_COMMAND} br ${selectedBook}`)]);
      if (isRuntimeManagedBook(config, state, selectedBook)) {
        buttons.push([button("📦 归档当前", `/${WORKLOG_COMMAND} ba ${selectedBook}`), button("🗑 删除空本", `/${WORKLOG_COMMAND} bd ${selectedBook}`)]);
      }
    }
  }

  if (isSenderRouted) {
    const bindingPreview = Object.entries(effectiveBindings).slice(0, 6).map(([sender, key]) => `${sender} → ${key}`);
    if (bindingPreview.length) {
      lines.push("", "最近绑定：", ...bindingPreview);
    }
    lines.push("", isAdmin ? "当前配置按发送者自动绑定；可创建、重命名、绑定或解绑日志本。" : "当前配置按发送者自动绑定，不提供全局切换。");
    buttons.push([button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)]);
    buttons.push([button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);
    return replyWithOptionalButtons(channel, lines.join("\n"), buttons);
  }

  if (!isAdmin) {
    lines.push("", "只有管理员可以切换全局当前日志本。", `创建示例：/${WORKLOG_COMMAND} create demo 演示日志本`, `改名示例：/${WORKLOG_COMMAND} rename ${currentBook || "demo"} 新名字`);
    return replyWithOptionalButtons(channel, lines.join("\n"), [
      [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
    ]);
  }

  for (const [key] of Object.entries(books).slice(0, 8)) {
    buttons.push([button(`${key === currentBook ? "✅ " : ""}${key}`, `/${WORKLOG_COMMAND} u ${key}`)]);
  }
  if (selectedBook) {
    lines.push("", `改名示例：/${WORKLOG_COMMAND} rename ${selectedBook} 新名字`);
  }
  lines.push(`创建示例：/${WORKLOG_COMMAND} create demo 演示日志本`);
  buttons.push([button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);
  return replyWithOptionalButtons(channel, lines.join("\n"), buttons);
}

function renderCreateBookPrompt(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本创建\n\n只有管理员可以新增日志本。", true);
  }

  return replyWithOptionalButtons(channel, [
    "新增日志本",
    "",
    "下一步：/worklog create <key> <名称>",
    `示例：/${WORKLOG_COMMAND} create demo 演示日志本`,
    "key 建议只用小写字母、数字、连字符。",
  ].join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderRenameBookPrompt(config: RuntimeConfig, senderId: string, book: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本重命名\n\n只有管理员可以重命名日志本。", true);
  }

  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  const current = books[book.trim()];
  if (!current) {
    return replyText(`日志本重命名\n\n日志本不存在：${book.trim()}`, true);
  }

  return replyWithOptionalButtons(channel, [
    "重命名日志本",
    "",
    `目标：${book.trim()}`,
    `当前名称：${current.name}`,
    "",
    `下一步：/${WORKLOG_COMMAND} rename ${book.trim()} <新名称>`,
    `示例：/${WORKLOG_COMMAND} rename ${book.trim()} ${current.name}`,
  ].join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleCreateBook(config: RuntimeConfig, senderId: string, book: string, rawName: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本创建\n\n只有管理员可以新增日志本。", true);
  }

  const key = normalizeBookKey(book);
  const name = normalizeBookName(rawName);
  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  if (books[key]) {
    return replyText(`日志本创建\n\n日志本已存在：${key}`, true);
  }

  const bookPath = normalizeBookPath(config.senderRouting.bookPathTemplate, config.dataRoot, senderId, key);
  assertBookPathAllowed(config, bookPath);
  const nextBook = { name, path: bookPath };
  state.books ??= {};
  state.books[key] = nextBook;
  if (config.senderRouting.mode === "current" && !state.currentBook) {
    state.currentBook = key;
  }
  saveState(config, state);
  ensureBookDir(nextBook);

  return replyWithOptionalButtons(channel, [
    "已新增日志本",
    "",
    `key：${key}`,
    `名称：${name}`,
    `目录：${bookPath}`,
    config.senderRouting.mode === "current" ? `切换命令：/${WORKLOG_COMMAND} u ${key}` : "当前为按发送者绑定模式，如需使用请先补绑定。",
  ].join("\n"), [
    ...(config.senderRouting.mode === "current" ? [[button("✅ 切到新本", `/${WORKLOG_COMMAND} u ${key}`)]] : []),
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleRenameBook(config: RuntimeConfig, senderId: string, book: string, rawName: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本重命名\n\n只有管理员可以重命名日志本。", true);
  }

  const key = book.trim();
  const nextName = normalizeBookName(rawName);
  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  const current = books[key];
  if (!current) {
    return replyText(`日志本重命名\n\n日志本不存在：${key}`, true);
  }

  state.books ??= {};
  state.books[key] = { ...current, name: nextName };
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "已重命名日志本",
    "",
    `key：${key}`,
    `新名称：${nextName}`,
    `目录：${current.path}`,
  ].join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderBindBookPrompt(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本绑定\n\n只有管理员可以管理 sender 绑定。", true);
  }

  const state = loadState(config);
  const bindings = Object.entries(state.senderBindings ?? {}).slice(0, 8).map(([sender, key]) => `${sender} → ${key}`);
  const lines = [
    "日志本绑定管理",
    "",
    `绑定命令：/${WORKLOG_COMMAND} bind <sender> <book>`,
    `示例：/${WORKLOG_COMMAND} bind telegram:6684352915 u-telegram-6684352915`,
    `解绑命令：/${WORKLOG_COMMAND} unbind <sender>`,
    `示例：/${WORKLOG_COMMAND} unbind telegram:6684352915`,
  ];
  if (bindings.length) {
    lines.push("", "当前运行时绑定：", ...bindings);
  }

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleBindBook(config: RuntimeConfig, senderId: string, targetSender: string, book: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本绑定\n\n只有管理员可以管理 sender 绑定。", true);
  }

  const normalizedSender = targetSender.trim();
  if (!normalizedSender) {
    return replyText("日志本绑定\n\nsender 不能为空。", true);
  }
  const key = book.trim();
  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  if (!books[key]) {
    return replyText(`日志本绑定\n\n日志本不存在：${key}`, true);
  }

  state.senderBindings ??= {};
  state.senderBindings[normalizedSender] = key;
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "已更新 sender 绑定",
    "",
    `sender：${normalizedSender}`,
    `日志本：${key}`,
    `名称：${books[key]?.name ?? key}`,
  ].join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleUnbindBook(config: RuntimeConfig, senderId: string, targetSender: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本绑定\n\n只有管理员可以管理 sender 绑定。", true);
  }

  const normalizedSender = targetSender.trim();
  const state = loadState(config);
  if (!state.senderBindings?.[normalizedSender]) {
    return replyText(`日志本解绑\n\n当前没有运行时绑定：${normalizedSender}`, true);
  }

  const previous = state.senderBindings[normalizedSender];
  delete state.senderBindings[normalizedSender];
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "已解绑 sender",
    "",
    `sender：${normalizedSender}`,
    `原日志本：${previous}`,
  ].join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderBindingsList(config: RuntimeConfig, senderId: string, page: number, query: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本绑定\n\n只有管理员可以查看完整绑定列表。", true);
  }

  const state = loadState(config);
  const entries = Object.entries(getEffectiveBindings(config, state))
    .filter(([sender, key]) => {
      const keyword = query.trim().toLowerCase();
      return !keyword || sender.toLowerCase().includes(keyword) || key.toLowerCase().includes(keyword);
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const pageItems = entries.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const lines = [
    "日志本绑定列表",
    "",
    `总数：${entries.length}`,
    `页码：${currentPage}/${totalPages}`,
    query.trim() ? `筛选：${query.trim()}` : "筛选：无",
    "",
    ...(pageItems.length ? pageItems.map(([sender, key]) => `${sender} → ${key}`) : ["没有匹配的绑定。"]),
  ];

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (currentPage > 1 || currentPage < totalPages) {
    buttons.push([
      ...(currentPage > 1 ? [button("⬅️ 上一页", `/${WORKLOG_COMMAND} bl ${currentPage - 1}${query.trim() ? ` ${query.trim()}` : ""}`)] : []),
      ...(currentPage < totalPages ? [button("➡️ 下一页", `/${WORKLOG_COMMAND} bl ${currentPage + 1}${query.trim() ? ` ${query.trim()}` : ""}`)] : []),
    ]);
  }
  buttons.push([button("🔗 绑定说明", `/${WORKLOG_COMMAND} bb`), button("📚 返回日志本", `/${WORKLOG_COMMAND} b`)]);
  buttons.push([button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);
  return replyWithOptionalButtons(channel, lines.join("\n"), buttons);
}

function renderArchiveBookConfirm(config: RuntimeConfig, senderId: string, book: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本归档\n\n只有管理员可以归档日志本。", true);
  }
  const state = loadState(config);
  const key = book.trim();
  const books = getEffectiveBooks(config, state);
  const current = books[key];
  if (!current) {
    return replyText(`日志本归档\n\n日志本不存在：${key}`, true);
  }
  if (!isRuntimeManagedBook(config, state, key)) {
    return replyText(`日志本归档\n\n只允许归档运行时创建的日志本：${key}`, true);
  }
  const usage = summarizeBookUsage(state, key);
  return replyWithOptionalButtons(channel, [
    "确认归档日志本",
    "",
    `key：${key}`,
    `名称：${current.name}`,
    `目录：${current.path}`,
    `运行时绑定数：${usage.bindingCount}`,
    usage.isCurrent ? "当前被设为 currentBook。" : "",
    "",
    "归档会把目录改名保留，并从活动日志本列表中移除。",
  ].filter(Boolean).join("\n"), [
    [button("📦 确认归档", `/${WORKLOG_COMMAND} baa ${key}`)],
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleArchiveBook(config: RuntimeConfig, senderId: string, book: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本归档\n\n只有管理员可以归档日志本。", true);
  }
  const state = loadState(config);
  const key = book.trim();
  const books = getEffectiveBooks(config, state);
  const current = books[key];
  if (!current) {
    return replyText(`日志本归档\n\n日志本不存在：${key}`, true);
  }
  if (!isRuntimeManagedBook(config, state, key)) {
    return replyText(`日志本归档\n\n只允许归档运行时创建的日志本：${key}`, true);
  }

  const archivedPath = archiveBookDirectory(current.path);
  detachRuntimeBook(state, key);
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "已归档日志本",
    "",
    `key：${key}`,
    `原目录：${current.path}`,
    `归档目录：${archivedPath}`,
  ].join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderDeleteBookConfirm(config: RuntimeConfig, senderId: string, book: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本删除\n\n只有管理员可以删除日志本。", true);
  }
  const state = loadState(config);
  const key = book.trim();
  const books = getEffectiveBooks(config, state);
  const current = books[key];
  if (!current) {
    return replyText(`日志本删除\n\n日志本不存在：${key}`, true);
  }
  if (!isRuntimeManagedBook(config, state, key)) {
    return replyText(`日志本删除\n\n只允许删除运行时创建的日志本：${key}`, true);
  }
  const files = listBookFiles(current.path);
  if (files.length > 0) {
    return replyText(`日志本删除\n\n${key} 目录非空，不能直接删。请先用 /${WORKLOG_COMMAND} ba ${key} 归档。`, true);
  }
  return replyWithOptionalButtons(channel, [
    "确认删除日志本",
    "",
    `key：${key}`,
    `名称：${current.name}`,
    `目录：${current.path}`,
    "",
    "只会删除空目录，并移除运行时状态。",
  ].join("\n"), [
    [button("🗑 确认删除", `/${WORKLOG_COMMAND} bdd ${key}`)],
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function handleDeleteBook(config: RuntimeConfig, senderId: string, book: string, channel: string): ReplyPayload {
  if (!adminSenderSet(config).has(senderId)) {
    return replyText("日志本删除\n\n只有管理员可以删除日志本。", true);
  }
  const state = loadState(config);
  const key = book.trim();
  const books = getEffectiveBooks(config, state);
  const current = books[key];
  if (!current) {
    return replyText(`日志本删除\n\n日志本不存在：${key}`, true);
  }
  if (!isRuntimeManagedBook(config, state, key)) {
    return replyText(`日志本删除\n\n只允许删除运行时创建的日志本：${key}`, true);
  }
  const files = listBookFiles(current.path);
  if (files.length > 0) {
    return replyText(`日志本删除\n\n${key} 目录非空，不能直接删。请先归档。`, true);
  }
  removeEmptyBookDirectory(current.path);
  detachRuntimeBook(state, key);
  saveState(config, state);

  return replyWithOptionalButtons(channel, [
    "已删除日志本",
    "",
    `key：${key}`,
    `目录：${current.path}`,
  ].join("\n"), [
    [button("📚 返回日志本", `/${WORKLOG_COMMAND} b`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
}

function renderWebAccess(config: RuntimeConfig, senderId: string, channel: string): ReplyPayload {
  const accessReply = ensureReadAllowed(config, senderId, channel);
  if (accessReply) {
    return accessReply;
  }

  const state = loadState(config);
  const resolved = resolveBook({ config, senderId });
  const month = formatLocalDay(new Date()).slice(0, 7);
  const previewUrl = buildSignedPreviewUrl(config, senderId, month, resolved.key);
  const lines = [
    "工作日志 Web 预览",
    "",
    `日志本：${formatBookSummary(config, state, senderId)}`,
    `月份：${month}`,
    "",
    "访问地址：",
    previewUrl,
    "",
    config.preview.publicBaseUrl ? "当前返回的是签名直链，没过期就能直接打开。" : (config.preview.host === "127.0.0.1" ? "当前地址仅本机可访问；如果要公网访问，请配置 preview.publicBaseUrl 或反向代理。" : "如果已完成读权限授权，浏览器打开后可直接看预览页。"),
  ];

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("📋 今日记录", `/${WORKLOG_COMMAND} t`), button("📊 本月统计", `/${WORKLOG_COMMAND} s`)],
    [button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)],
  ]);
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
  const isAdmin = adminSenderSet(config).has(senderId);
  const lines = [
    "工作日志帮助",
    "",
    `入口：/${WORKLOG_COMMAND}`,
    `当前日志本：${formatBookSummary(config, state, senderId)}`,
    "",
    "常用命令：",
    `- /${WORKLOG_COMMAND}：打开主菜单`,
    `- /${WORKLOG_COMMAND} today：查看今日记录`,
    `- /${WORKLOG_COMMAND} month：查看本月统计`,
    `- /${WORKLOG_COMMAND} recent：查看最近 7 天摘要`,
    `- /${WORKLOG_COMMAND} web：查看 Web 预览地址`,
    `- /${WORKLOG_COMMAND} 1.5 修复筛选回显：快速记一条`,
    `- /${WORKLOG_COMMAND} batch：批量记录多条工作项`,
    `- /${WORKLOG_COMMAND} 今天修复筛选回显 1.5 小时：自然语言草稿确认`,
    `- /${WORKLOG_COMMAND} 工作项：修复筛选回显，工时：1.5：结构化草稿确认`,
    `- /${WORKLOG_COMMAND} edit <yyyy-mm-dd> <序号>：进入单条编辑态`,
    `- /${WORKLOG_COMMAND} delete <yyyy-mm-dd> <序号>：进入删除确认`,
    `- /${WORKLOG_COMMAND} delete <yyyy-mm-dd> 1,2,3：进入批量删除确认`,
    channel === "telegram" ? `- 今日记录卡片支持“批量删除”多选模式` : "",
    config.commentPolicy.enabled ? `- /${WORKLOG_COMMAND} comment [yyyy-mm-dd] <锐评>：补写或覆盖锐评` : "",
    getAiAvailability(config).ok ? `- /${WORKLOG_COMMAND} ai-polish：对待确认草稿或整批草稿做 AI 润色` : "",
    getAiAvailability(config).ok ? `- /${WORKLOG_COMMAND} ai-comment [yyyy-mm-dd]：AI 检测是否值得补锐评` : "",
    config.readAccess.requirePasswordForNonAdminRead ? `- /${WORKLOG_COMMAND} auth <口令>：解锁读取权限` : "",
    "",
    "管理命令：",
    `- /${WORKLOG_COMMAND} books：查看日志本面板`,
    `- /${WORKLOG_COMMAND} create <key> <名称>：新增日志本`,
    `- /${WORKLOG_COMMAND} rename <key> <新名称>：重命名日志本`,
    `- /${WORKLOG_COMMAND} bind <sender> <book>：绑定 sender 到日志本`,
    `- /${WORKLOG_COMMAND} unbind <sender>：解绑 sender`,
    `- /${WORKLOG_COMMAND} bindings [页码] [关键字]：查看绑定列表`,
    `- /${WORKLOG_COMMAND} ba <book>：归档运行时日志本`,
    `- /${WORKLOG_COMMAND} bd <book>：删除空的运行时日志本`,
    config.senderRouting.mode === "by_sender_id" ? "" : `- /${WORKLOG_COMMAND} use <book>：管理员切换全局当前日志本`,
    "",
    isAdmin ? "管理员危险操作简表：" : "",
    isAdmin ? "1. 删除前先看是否为空目录；非空先归档再处理。" : "",
    isAdmin ? "2. 归档/删除只建议对运行时日志本做，别动静态配置本。" : "",
    isAdmin ? "3. sender 绑定调整后，立即用 /worklog bindings 复核。" : "",
    isAdmin ? "4. 详细清单见：docs/worklog-admin-danger-checklist.md" : "",
    "",
    channel === "telegram" ? "Telegram 下会尽量复用同一张卡片，并在今日记录里提供单条编辑/删除/锐评按钮。" : "非 Telegram 渠道继续使用纯命令模式。",
    "记录规则文件：config/worklog-writing-rules.md",
  ].filter(Boolean);

  return replyWithOptionalButtons(channel, lines.join("\n"), [
    [button("📚 日志本", `/${WORKLOG_COMMAND} b`), button("🌐 Web 地址", `/${WORKLOG_COMMAND} w`)],
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
    `可先执行 /${WORKLOG_COMMAND} help 或回主菜单。`,
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

function isRuntimeManagedBook(config: RuntimeConfig, state: RuntimeState, key: string): boolean {
  return Boolean(state.books?.[key]) && !Object.prototype.hasOwnProperty.call(config.books, key);
}

function summarizeBookUsage(state: RuntimeState, key: string): { bindingCount: number; isCurrent: boolean } {
  const bindingCount = Object.values(state.senderBindings ?? {}).filter((value) => value === key).length;
  return {
    bindingCount,
    isCurrent: state.currentBook === key,
  };
}

function listBookFiles(bookPath: string): string[] {
  if (!fs.existsSync(bookPath)) {
    return [];
  }
  return fs.readdirSync(bookPath).filter((entry) => entry !== "." && entry !== "..");
}

function archiveBookDirectory(bookPath: string): string {
  if (!fs.existsSync(bookPath)) {
    return `${bookPath}.archived-missing`;
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const nextPath = `${bookPath}.archived-${stamp}`;
  fs.renameSync(bookPath, nextPath);
  return nextPath;
}

function removeEmptyBookDirectory(bookPath: string): void {
  if (!fs.existsSync(bookPath)) {
    return;
  }
  if (listBookFiles(bookPath).length > 0) {
    throw new Error("日志本目录非空，不能直接删除。");
  }
  fs.rmdirSync(bookPath);
}

function detachRuntimeBook(state: RuntimeState, key: string): void {
  if (state.books) {
    delete state.books[key];
  }
  if (state.senderBindings) {
    for (const [sender, boundKey] of Object.entries(state.senderBindings)) {
      if (boundKey === key) {
        delete state.senderBindings[sender];
      }
    }
  }
  if (state.currentBook === key) {
    delete state.currentBook;
  }
}

function normalizeBookKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/.test(trimmed)) {
    throw new Error("日志本 key 只允许小写字母、数字、连字符、下划线，且需以字母或数字开头。");
  }
  return trimmed;
}

function normalizeBookName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("日志本名称不能为空。");
  }
  if (trimmed.length > 80) {
    throw new Error("日志本名称过长（>80）。");
  }
  return trimmed;
}

function assertBookPathAllowed(config: RuntimeConfig, bookPath: string): void {
  if (!config.writeGuard.restrictedPathPrefix) {
    return;
  }
  const normalizedBookPath = path.resolve(bookPath);
  const normalizedPrefix = path.resolve(config.writeGuard.restrictedPathPrefix);
  const withSep = normalizedPrefix.endsWith(path.sep) ? normalizedPrefix : `${normalizedPrefix}${path.sep}`;
  if (normalizedBookPath !== normalizedPrefix && !normalizedBookPath.startsWith(withSep)) {
    throw new Error("新日志本目录超出允许范围。");
  }
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
  if (state.mode === "awaiting_append_confirm") {
    return `待确认草稿（${fmtHours(state.hours)}h）`;
  }
  if (state.mode === "awaiting_entry_replace") {
    return `待替换第 ${state.rowIndex} 条（${fmtHours(state.currentHours)}h）`;
  }
  if (state.mode === "awaiting_comment_confirm") {
    return `待确认锐评（${state.day}）`;
  }
  if (state.mode === "awaiting_batch_confirm") {
    return `待确认批量草稿（${state.day} · ${state.entries.length}条）`;
  }
  if (state.mode === "awaiting_delete_selection") {
    return `待批量删除（${state.day} · ${state.selectedRowIndices.length}条）`;
  }
  return "空闲";
}

function clearDeleteSelectionInput(config: RuntimeConfig, senderId: string, channel: string): void {
  const state = loadState(config);
  const input = getInputState(state, channel, senderId);
  if (input?.mode !== "awaiting_delete_selection") {
    return;
  }
  clearInputState(state, channel, senderId);
  saveState(config, state);
}
function clearActiveInput(config: RuntimeConfig, senderId: string, channel: string): void {
  const state = loadState(config);
  clearInputState(state, channel, senderId);
  saveState(config, state);
}

function normalizeSenderId(ctx: PluginCommandContext): string | null {
  const raw = ctx.senderId ?? ctx.from ?? null;
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes(":")) {
    return trimmed;
  }
  if (ctx.channel === "telegram" && /^\d+$/.test(trimmed)) {
    return `telegram:${trimmed}`;
  }
  if (ctx.channel === "vocechat" && /^\d+$/.test(trimmed)) {
    return `vocechat:user:${trimmed}`;
  }
  if (ctx.channel === "qqbot" && /^\d+$/.test(trimmed)) {
    return `qqbot:${trimmed}`;
  }
  return trimmed;
}

function buildMenuButtons(): TelegramInlineKeyboardButton[][] {
  return [
    [button("➕ 记录日志", `/${WORKLOG_COMMAND} a`), button("📋 今日记录", `/${WORKLOG_COMMAND} t`)],
    [button("📊 本月统计", `/${WORKLOG_COMMAND} s`), button("⚙️ 帮助", `/${WORKLOG_COMMAND} h`)],
    [button("🗓 最近7天", `/${WORKLOG_COMMAND} r`), button("📚 日志本", `/${WORKLOG_COMMAND} b`)],
    [button("🌐 Web 地址", `/${WORKLOG_COMMAND} w`)],
  ];
}

function buildSuccessButtons(config: RuntimeConfig, day = formatLocalDay(new Date())): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [
    [button("➕ 再记一条", `/${WORKLOG_COMMAND} a`), button("📋 今日记录", `/${WORKLOG_COMMAND} t`)],
  ];
  const today = formatLocalDay(new Date());
  if (config.commentPolicy.enabled && (config.commentPolicy.allowSameDayComment || day !== today)) {
    const commentRow: TelegramInlineKeyboardButton[] = [button("💬 补锐评", `/${WORKLOG_COMMAND} c ${day}`)];
    if (getAiAvailability(config).ok) {
      commentRow.push(button("🧠 检测锐评", `/${WORKLOG_COMMAND} ai-comment ${day}`));
    }
    rows.push(commentRow);
  }
  rows.push([button("📊 本月统计", `/${WORKLOG_COMMAND} s`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);
  return rows;
}

function buildAppendDraftButtons(config: RuntimeConfig, day: string): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [
    [button("✅ 写入", `/${WORKLOG_COMMAND} confirm`), button("✏️ 修改", `/${WORKLOG_COMMAND} modify`)],
  ];
  if (getAiAvailability(config).ok) {
    rows.push([button("🪄 AI 润色", `/${WORKLOG_COMMAND} ai-polish`)]);
  }
  rows.push([button("❌ 取消", `/${WORKLOG_COMMAND} x`), button("⬅️ 主菜单", `/${WORKLOG_COMMAND} m`)]);
  return rows;
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

function replyWithOptionalButtons(channel: string, text: string, buttons: TelegramInlineKeyboardButton[][], isError = false): ReplyPayload {
  if (channel === "telegram") {
    return replyWithButtons(text, buttons, isError);
  }
  return replyText(text, isError);
}

function toTelegramPanelMessage(payload: ReplyPayload, panelId: string): TelegramPanelMessage {
  const text = payload.text ?? "工作日志";
  const buttons = payload.channelData?.telegram && typeof payload.channelData.telegram === "object"
    ? (payload.channelData.telegram as { buttons?: TelegramInlineKeyboardButton[][] }).buttons ?? []
    : [];

  const wrappedButtons = buttons.map((row) => row.map((entry) => {
    const callbackData = typeof entry.callback_data === "string" ? wrapPanelCallback(entry.callback_data, panelId) : undefined;
    return {
      text: entry.text,
      ...(entry.style ? { style: entry.style } : {}),
      ...(callbackData ? { callback_data: callbackData } : {}),
    };
  }));

  return {
    text,
    ...(wrappedButtons.length ? { replyMarkup: { inline_keyboard: wrappedButtons } } : {}),
  };
}

function wrapPanelCallback(callbackData: string, panelId: string): string {
  const prefix = `/${WORKLOG_COMMAND}`;
  if (!callbackData.startsWith(prefix)) {
    return callbackData;
  }
  const suffix = callbackData.slice(prefix.length).trim();
  return suffix ? `${prefix} p ${panelId} ${suffix}` : `${prefix} p ${panelId}`;
}

function humanizeWorklogError(message: string, senderId: string): string {
  switch (message) {
    case "sender-not-allowed-for-auto-bind":
      return [
        "当前发送者还没被允许自动绑定日志本。",
        `sender：${senderId}`,
        "请先把这个 sender 加进 worklog 的 allowAutoBindSenders，或由管理员先执行一次 /worklog bind。",
      ].join("\n");
    case "viewer-password-not-configured":
      return "管理员还没配置工作日志读取口令。";
    case "invalid-password":
      return "工作日志口令不正确。";
    default:
      return message;
  }
}

function formatLocalDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type TelegramRuntime = {
  botToken: string;
  apiBaseUrl?: string;
  proxyUrl?: string | null;
  requestTimeoutMs?: number;
};

function resolveTelegramRuntime(openclawConfig: Record<string, unknown>): TelegramRuntime | null {
  const channels = asRecord(openclawConfig.channels);
  const telegram = asRecord(channels?.telegram);
  const botToken = readString(telegram?.botToken);
  if (!botToken) {
    return null;
  }
  return {
    botToken,
    apiBaseUrl: readString(telegram?.apiBaseUrl) ?? undefined,
    proxyUrl: readString(telegram?.proxy),
    requestTimeoutMs: readNumber(telegram?.requestTimeoutMs) ?? 15_000,
  };
}

function resolvePanelStateFile(config: RuntimeConfig): string {
  return path.join(path.dirname(config.stateFile), ".worklog-panel-state.json");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

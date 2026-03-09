import path from "node:path";

import { adminSenderSet, getBoundBookForSender, resolveBook } from "./access.js";
import { getEffectiveBooks, loadState } from "./state-store.js";
import type { RuntimeConfig } from "./types.js";

export function validateWorkItem(item: string, config: RuntimeConfig): string {
  const normalized = config.writeGuard.review.trimWhitespace ? normalizeWhitespace(item) : item.trim();
  const trimmed = stripLeadingItemNumber(normalized);
  if (!trimmed) {
    throw new Error("工作项不能为空。");
  }
  if (trimmed.length > config.writeGuard.review.maxItemLength) {
    throw new Error(`工作项长度超限（>${config.writeGuard.review.maxItemLength}）。`);
  }
  if (matchesForbiddenPattern(trimmed, config.writeGuard.review.forbiddenPatterns)) {
    throw new Error(config.writeGuard.review.forbiddenMessage);
  }
  return trimmed;
}

export function validateComment(comment: string, config: RuntimeConfig): string {
  const trimmed = normalizeWhitespace(comment);
  if (!trimmed) {
    throw new Error("锐评内容不能为空。");
  }
  if (trimmed.length > config.commentPolicy.maxLength) {
    throw new Error(`锐评长度超限（>${config.commentPolicy.maxLength}）。`);
  }
  if (matchesForbiddenPattern(trimmed, config.writeGuard.review.forbiddenPatterns)) {
    throw new Error(config.writeGuard.review.forbiddenMessage);
  }
  return trimmed;
}

export function enforceWriteScope(params: {
  config: RuntimeConfig;
  senderId: string;
  key: string;
}): void {
  const { config, senderId, key } = params;
  if (!config.writeGuard.enabled) {
    return;
  }

  const admins = adminSenderSet(config);
  if (senderId && admins.has(senderId)) {
    return;
  }

  if (!senderId) {
    throw new Error("非管理员写入必须提供 senderId。");
  }

  const currentBoundKey = getBoundBookForSender(config, senderId);
  if (!currentBoundKey) {
    resolveBook({ config, senderId });
  }

  const finalBoundKey = getBoundBookForSender(config, senderId);
  if (!finalBoundKey) {
    throw new Error("sender 未绑定可写日志本。");
  }
  if (finalBoundKey !== key) {
    throw new Error("非管理员仅可写入自己的日志本。");
  }

  enforcePathPrefix(config, key);
}

export function enforceReadScope(params: {
  config: RuntimeConfig;
  senderId: string;
  key: string;
}): void {
  const { config, senderId, key } = params;
  const admins = adminSenderSet(config);
  if (senderId && admins.has(senderId)) {
    return;
  }

  if (!senderId) {
    throw new Error("非管理员读取必须提供 senderId。");
  }

  const boundKey = getBoundBookForSender(config, senderId);
  if (!boundKey) {
    throw new Error("sender 未绑定可读日志本。");
  }
  if (boundKey !== key) {
    throw new Error("非管理员仅可读取自己的日志本。");
  }

  enforcePathPrefix(config, key);
}

function enforcePathPrefix(config: RuntimeConfig, key: string): void {
  if (!config.writeGuard.restrictedPathPrefix) {
    return;
  }

  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  const bookPath = books[key]?.path;
  if (!bookPath) {
    throw new Error(`日志本不存在：${key}`);
  }

  const normalizedBookPath = path.resolve(bookPath);
  const normalizedPrefix = path.resolve(config.writeGuard.restrictedPathPrefix);
  const withSep = normalizedPrefix.endsWith(path.sep) ? normalizedPrefix : `${normalizedPrefix}${path.sep}`;
  if (normalizedBookPath !== normalizedPrefix && !normalizedBookPath.startsWith(withSep)) {
    throw new Error("目标路径超出允许范围。");
  }
}

function stripLeadingItemNumber(text: string): string {
  return text.replace(/^d+.s*/u, "").trim();
}

function matchesForbiddenPattern(text: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, "i").test(text)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

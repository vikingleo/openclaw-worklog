import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expandTemplate, normalizeBookPath } from "./config.js";
import { ensureBookDir, getEffectiveBindings, getEffectiveBooks, loadState, purgeExpiredSessions, saveState, setSession } from "./state-store.js";
import type { AccessResult, ReadSessionRecord, RuntimeConfig, RuntimeState, WorklogBookConfig } from "./types.js";

export function resolveBook(params: {
  config: RuntimeConfig;
  senderId: string;
  requestedBook?: string;
}): { key: string; created: boolean; state: RuntimeState } {
  const { config, senderId, requestedBook } = params;
  const state = loadState(config);

  if (requestedBook?.trim()) {
    return { key: requestedBook.trim(), created: false, state };
  }

  if (config.senderRouting.mode !== "by_sender_id") {
    const current = state.currentBook ?? config.currentBook ?? config.defaultBook;
    if (!current) {
      throw new Error("未配置默认日志本。");
    }
    return { key: current, created: false, state };
  }

  const bindings = getEffectiveBindings(config, state);
  const boundKey = bindings[senderId];
  if (boundKey) {
    return { key: boundKey, created: false, state };
  }

  const allowAuto = new Set(config.senderRouting.allowAutoBindSenders);
  if (allowAuto.size && !allowAuto.has(senderId)) {
    throw new Error("sender-not-allowed-for-auto-bind");
  }

  const key = safeKey(`${config.senderRouting.bookKeyPrefix}-${senderId}`);
  const books = getEffectiveBooks(config, state);
  if (books[key]) {
    state.senderBindings ??= {};
    state.senderBindings[senderId] = key;
    saveState(config, state);
    return { key, created: false, state };
  }

  if (!config.senderRouting.autoCreate) {
    const current = state.currentBook ?? config.currentBook ?? config.defaultBook;
    if (!current) {
      throw new Error("未找到可写入日志本。");
    }
    return { key: current, created: false, state };
  }

  const book = buildAutoBook(config, senderId, key);
  state.books ??= {};
  state.senderBindings ??= {};
  state.books[key] = book;
  state.senderBindings[senderId] = key;
  ensureBookDir(book);
  saveState(config, state);
  return { key, created: true, state };
}

export function adminSenderSet(config: RuntimeConfig): Set<string> {
  return new Set([
    ...config.readAccess.adminSenderIds,
    ...config.writeGuard.adminSenderIds,
  ]);
}

export function getBoundBookForSender(config: RuntimeConfig, senderId: string): string | null {
  const state = loadState(config);
  const bindings = getEffectiveBindings(config, state);
  return bindings[senderId] ?? null;
}

export function checkReadAccess(config: RuntimeConfig, senderId: string, sessionToken?: string | null): AccessResult {
  const state = loadState(config);
  const admins = adminSenderSet(config);
  if (admins.has(senderId)) {
    return { status: "ok", message: "admin", isAdmin: true, requiresPassword: false };
  }

  if (!config.readAccess.requirePasswordForNonAdminRead) {
    return { status: "ok", message: "no-password-required", isAdmin: false, requiresPassword: false };
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const changed = purgeExpiredSessions(state, nowTs);
  const sessions = state.readSessions ?? {};
  const directTokenRecord = sessionToken ? sessions[sessionToken] : null;
  const hasDirectToken = Boolean(
    directTokenRecord
    && directTokenRecord.sender === senderId
    && Number(directTokenRecord.expiresAt) > nowTs,
  );
  const authorized = hasDirectToken || Object.values(sessions).some(
    (record) => record.sender === senderId && Number(record.expiresAt) > nowTs,
  );

  if (changed) {
    saveState(config, state);
  }

  if (authorized) {
    return { status: "ok", message: hasDirectToken ? "authorized-token" : "authorized-session", isAdmin: false, requiresPassword: false };
  }

  return {
    status: "auth_required",
    message: "non-admin-read-requires-password",
    isAdmin: false,
    requiresPassword: true,
  };
}

export function authorizeViewer(config: RuntimeConfig, senderId: string, password: string): AccessResult {
  return authorizeViewerSession(config, senderId, password).result;
}

export function authorizeViewerSession(config: RuntimeConfig, senderId: string, password: string): {
  result: AccessResult;
  token: string | null;
  expiresAt: number | null;
} {
  const expected = loadExpectedViewerPassword(config);
  if (!expected) {
    return {
      result: { status: "error", message: "viewer-password-not-configured", isAdmin: false, requiresPassword: true },
      token: null,
      expiresAt: null,
    };
  }

  if (password !== expected) {
    return {
      result: { status: "denied", message: "invalid-password", isAdmin: false, requiresPassword: true },
      token: null,
      expiresAt: null,
    };
  }

  const state = loadState(config);
  const nowTs = Math.floor(Date.now() / 1000);
  purgeExpiredSessions(state, nowTs);
  const ttlSeconds = Math.max(60, config.readAccess.sessionTtlMinutes * 60);
  const token = crypto.randomBytes(18).toString("base64url");
  const expiresAt = nowTs + ttlSeconds;
  setSession(state, token, {
    sender: senderId,
    createdAt: nowTs,
    expiresAt,
  });
  saveState(config, state);

  return {
    result: { status: "ok", message: "authorized", isAdmin: false, requiresPassword: false },
    token,
    expiresAt,
  };
}

export function getReadSession(config: RuntimeConfig, token: string): ReadSessionRecord | null {
  const state = loadState(config);
  const nowTs = Math.floor(Date.now() / 1000);
  const changed = purgeExpiredSessions(state, nowTs);
  const record = (state.readSessions ?? {})[token] ?? null;
  if (changed) {
    saveState(config, state);
  }
  if (!record || Number(record.expiresAt) <= nowTs) {
    return null;
  }
  return record;
}

export function locateBookPath(config: RuntimeConfig, key: string): string {
  const state = loadState(config);
  const books = getEffectiveBooks(config, state);
  const book = books[key];
  if (!book) {
    throw new Error(`日志本不存在：${key}`);
  }
  return book.path;
}

function buildAutoBook(config: RuntimeConfig, senderId: string, key: string): WorklogBookConfig {
  const name = expandTemplate(config.senderRouting.nameTemplate, {
    dataRoot: config.dataRoot,
    sender_id: senderId,
    key,
  });
  const bookPath = normalizeBookPath(config.senderRouting.bookPathTemplate, config.dataRoot, senderId, key);
  return { name, path: bookPath };
}

function safeKey(text: string): string {
  const lowered = text.trim().toLowerCase();
  const sanitized = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (sanitized) {
    return sanitized.slice(0, 64);
  }
  return `id-${crypto.createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
}

function loadExpectedViewerPassword(config: RuntimeConfig): string | null {
  const envValue = process.env[config.readAccess.viewerPasswordEnv]?.trim();
  if (envValue) {
    return envValue;
  }

  const envFile = config.readAccess.viewerPasswordEnvFile;
  if (!envFile || !fs.existsSync(envFile)) {
    return null;
  }

  const lines = fs.readFileSync(path.resolve(envFile), "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const [key, ...rest] = line.split("=");
    if (key.trim() === config.readAccess.viewerPasswordEnv) {
      return rest.join("=").trim() || null;
    }
  }

  return null;
}

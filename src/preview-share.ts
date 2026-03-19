import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadExpectedViewerPassword } from "./access.js";
import { ensureParentDir } from "./config.js";
import { resolvePreviewBaseUrl } from "./preview-url.js";
import type { RuntimeConfig } from "./types.js";

export type WorklogShareMode = "preview" | "raw";
type PersistentShareRecord = {
  senderId: string;
  book: string;
  createdAt: number;
  updatedAt: number;
};

export function buildSignedPreviewUrl(config: RuntimeConfig, senderId: string, month: string, book?: string): string {
  return buildSignedWorklogUrl({ config, senderId, month, book, mode: "preview" });
}

export function buildSignedRawUrl(config: RuntimeConfig, senderId: string, month: string, book?: string): string {
  return buildSignedWorklogUrl({ config, senderId, month, book, mode: "raw" });
}

export function buildPersistentPreviewUrl(config: RuntimeConfig, token: string, month: string): string {
  const url = new URL(resolvePreviewBaseUrl(config));
  url.searchParams.set("share", token);
  url.searchParams.set("month", month);
  return url.toString();
}

export function buildPersistentRawUrl(config: RuntimeConfig, token: string, month: string): string {
  const url = new URL(`${resolvePreviewBaseUrl(config)}/raw`);
  url.searchParams.set("share", token);
  url.searchParams.set("month", month);
  return url.toString();
}

export function getPersistentShare(config: RuntimeConfig, senderId: string, book: string): { token: string; url: string } | null {
  const normalizedBook = book.trim();
  if (!normalizedBook) {
    return null;
  }
  const match = Object.entries(loadPersistentShareStore(config))
    .find(([, record]) => record.senderId === senderId && record.book === normalizedBook);
  if (!match) {
    return null;
  }
  return {
    token: match[0],
    url: buildPersistentPreviewUrl(config, match[0], currentMonth()),
  };
}

export function ensurePersistentShare(config: RuntimeConfig, senderId: string, book: string): string {
  const normalizedBook = book.trim();
  const existing = getPersistentShare(config, senderId, normalizedBook);
  const store = loadPersistentShareStore(config);
  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    store[existing.token] = {
      ...store[existing.token],
      updatedAt: now,
    };
    savePersistentShareStore(config, store);
    return existing.token;
  }

  const token = crypto.randomBytes(18).toString("base64url");
  store[token] = {
    senderId,
    book: normalizedBook,
    createdAt: now,
    updatedAt: now,
  };
  savePersistentShareStore(config, store);
  return token;
}

export function revokePersistentShare(config: RuntimeConfig, senderId: string, book: string): boolean {
  const normalizedBook = book.trim();
  const store = loadPersistentShareStore(config);
  let removed = false;
  for (const [token, record] of Object.entries(store)) {
    if (record.senderId === senderId && record.book === normalizedBook) {
      delete store[token];
      removed = true;
    }
  }
  if (removed) {
    savePersistentShareStore(config, store);
  }
  return removed;
}

export function verifyPersistentWorklogAccess(params: {
  config: RuntimeConfig;
  shareToken: string | null;
}): { ok: true; token: string; senderId: string; book: string } | { ok: false; reason: string } | null {
  const token = params.shareToken?.trim() ?? "";
  if (!token) {
    return null;
  }
  const record = loadPersistentShareStore(params.config)[token];
  if (!record) {
    return { ok: false, reason: "分享链接不存在或已失效。" };
  }
  return {
    ok: true,
    token,
    senderId: record.senderId,
    book: record.book,
  };
}

export function verifySignedWorklogAccess(params: {
  config: RuntimeConfig;
  senderId: string;
  month: string;
  book?: string | null;
  expRaw: string | null;
  sigRaw: string | null;
  mode: WorklogShareMode;
}): { ok: true; expiresAt: number } | { ok: false; reason: string } | null {
  const { config, senderId, month, book, expRaw, sigRaw, mode } = params;
  const expValue = expRaw?.trim() ?? "";
  const sigValue = sigRaw?.trim().toLowerCase() ?? "";
  if (!expValue && !sigValue) {
    return null;
  }
  if (!expValue || !sigValue) {
    return { ok: false, reason: "缺少签名参数。" };
  }
  if (!/^\d+$/.test(expValue)) {
    return { ok: false, reason: "签名时间戳无效。" };
  }
  const expiresAt = Number.parseInt(expValue, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, reason: "签名时间戳无效。" };
  }
  if (expiresAt < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "签名链接已过期。" };
  }
  const secret = resolvePreviewShareSecret(config);
  if (!secret) {
    return { ok: false, reason: "未配置预览签名密钥。" };
  }
  const expected = signPayload({ secret, senderId, month, book: book ?? "", mode, exp: expiresAt });
  if (!crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sigValue, "utf8"))) {
    return { ok: false, reason: "签名不正确。" };
  }
  return { ok: true, expiresAt };
}

function buildSignedWorklogUrl(params: {
  config: RuntimeConfig;
  senderId: string;
  month: string;
  book?: string;
  mode: WorklogShareMode;
}): string {
  const { config, senderId, month, book, mode } = params;
  const expiresAt = Math.floor(Date.now() / 1000) + config.preview.shareTtlSeconds;
  const secret = resolvePreviewShareSecret(config);
  if (!secret) {
    return buildPlainUrl({ config, senderId, month, book, mode });
  }
  const url = new URL(buildPlainUrl({ config, senderId, month, book, mode }));
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", signPayload({ secret, senderId, month, book: book ?? "", mode, exp: expiresAt }));
  return url.toString();
}

function buildPlainUrl(params: {
  config: RuntimeConfig;
  senderId: string;
  month: string;
  book?: string;
  mode: WorklogShareMode;
}): string {
  const { config, senderId, month, book, mode } = params;
  const base = mode === "raw"
    ? `${resolvePreviewBaseUrl(config)}/raw`
    : resolvePreviewBaseUrl(config);
  const url = new URL(base);
  url.searchParams.set("senderId", senderId);
  url.searchParams.set("month", month);
  if (book?.trim()) {
    url.searchParams.set("book", book.trim());
  }
  return url.toString();
}

function signPayload(params: {
  secret: string;
  senderId: string;
  month: string;
  book: string;
  mode: WorklogShareMode;
  exp: number;
}): string {
  const payload = [params.mode, params.senderId, params.month, params.book, String(params.exp)].join("\n");
  return crypto.createHmac("sha256", params.secret).update(payload).digest("hex");
}

function resolvePreviewShareSecret(config: RuntimeConfig): string | null {
  const envName = config.preview.shareSecretEnv.trim();
  const envValue = (envName ? process.env[envName] : "")?.trim();
  if (envValue) {
    return envValue;
  }
  return loadExpectedViewerPassword(config);
}

function resolvePersistentShareStorePath(config: RuntimeConfig): string {
  return path.join(path.dirname(config.stateFile), ".worklog-preview-shares.json");
}

function loadPersistentShareStore(config: RuntimeConfig): Record<string, PersistentShareRecord> {
  const storePath = resolvePersistentShareStorePath(config);
  if (!fs.existsSync(storePath)) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    const output: Record<string, PersistentShareRecord> = {};
    for (const [token, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const senderId = String((value as PersistentShareRecord).senderId ?? "").trim();
      const book = String((value as PersistentShareRecord).book ?? "").trim();
      if (!senderId || !book) {
        continue;
      }
      output[token] = {
        senderId,
        book,
        createdAt: Number((value as PersistentShareRecord).createdAt ?? 0) || 0,
        updatedAt: Number((value as PersistentShareRecord).updatedAt ?? 0) || 0,
      };
    }
    return output;
  } catch {
    return {};
  }
}

function savePersistentShareStore(config: RuntimeConfig, store: Record<string, PersistentShareRecord>): void {
  const storePath = resolvePersistentShareStorePath(config);
  ensureParentDir(storePath);
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function currentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

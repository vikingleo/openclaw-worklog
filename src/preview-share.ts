import crypto from "node:crypto";

import { loadExpectedViewerPassword } from "./access.js";
import { resolvePreviewBaseUrl } from "./preview-url.js";
import type { RuntimeConfig } from "./types.js";

export type WorklogShareMode = "preview" | "raw";

export function buildSignedPreviewUrl(config: RuntimeConfig, senderId: string, month: string, book?: string): string {
  return buildSignedWorklogUrl({ config, senderId, month, book, mode: "preview" });
}

export function buildSignedRawUrl(config: RuntimeConfig, senderId: string, month: string, book?: string): string {
  return buildSignedWorklogUrl({ config, senderId, month, book, mode: "raw" });
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

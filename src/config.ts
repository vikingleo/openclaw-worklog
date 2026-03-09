import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimeConfig, WorklogBookConfig } from "./types.js";

type JsonObject = Record<string, unknown>;
type AnyConfig = Record<string, any>;

export function buildRuntimeConfigFromPlugin(params: {
  openclawConfig: AnyConfig;
  pluginConfig?: Record<string, unknown>;
}): RuntimeConfig {
  void params.openclawConfig;
  const raw = (params.pluginConfig ?? {}) as AnyConfig;
  const dataRoot = expandHome(readString(raw.dataRoot) ?? path.join(os.homedir(), ".worklog-data"));
  const stateFile = expandHome(readString(raw.stateFile) ?? path.join(dataRoot, ".plugin-state.json"));

  return {
    enabled: readBoolean(raw.enabled, true),
    dataRoot,
    stateFile,
    defaultBook: readString(raw.defaultBook),
    currentBook: readString(raw.currentBook),
    monthlyTargetHours: clamp(readNumber(raw.monthlyTargetHours) ?? 176, 0, Number.MAX_SAFE_INTEGER),
    books: normalizeBooks(raw.books, dataRoot),
    senderRouting: {
      mode: normalizeRoutingMode(readString(raw.senderRouting?.mode)),
      autoCreate: readBoolean(raw.senderRouting?.autoCreate, true),
      bookKeyPrefix: readString(raw.senderRouting?.bookKeyPrefix) ?? "u",
      nameTemplate: readString(raw.senderRouting?.nameTemplate) ?? "{sender_id}工作日志",
      bookPathTemplate: readString(raw.senderRouting?.bookPathTemplate) ?? "{dataRoot}/users/{key}",
      allowAutoBindSenders: normalizeStringArray(raw.senderRouting?.allowAutoBindSenders),
      bindings: normalizeStringMap(raw.senderRouting?.bindings),
    },
    readAccess: {
      requirePasswordForNonAdminRead: readBoolean(raw.readAccess?.requirePasswordForNonAdminRead, false),
      viewerPasswordEnv: readString(raw.readAccess?.viewerPasswordEnv) ?? "WORKLOG_VIEWER_PASSWORD",
      viewerPasswordEnvFile: readString(raw.readAccess?.viewerPasswordEnvFile),
      sessionTtlMinutes: clamp(readNumber(raw.readAccess?.sessionTtlMinutes) ?? 60, 1, 24 * 60),
      adminSenderIds: normalizeStringArray(raw.readAccess?.adminSenderIds),
    },
    writeGuard: {
      enabled: readBoolean(raw.writeGuard?.enabled, true),
      adminSenderIds: normalizeStringArray(raw.writeGuard?.adminSenderIds),
      restrictedPathPrefix: readString(raw.writeGuard?.restrictedPathPrefix)
        ? expandTemplate(readString(raw.writeGuard?.restrictedPathPrefix) as string, { dataRoot })
        : null,
      denyFileUpload: readBoolean(raw.writeGuard?.denyFileUpload, true),
      review: {
        trimWhitespace: readBoolean(raw.writeGuard?.review?.trimWhitespace, true),
        maxItemLength: clamp(readNumber(raw.writeGuard?.review?.maxItemLength) ?? 500, 1, 100_000),
        forbiddenPatterns: normalizeStringArray(raw.writeGuard?.review?.forbiddenPatterns),
        forbiddenMessage:
          readString(raw.writeGuard?.review?.forbiddenMessage)
          ?? "内容未通过安全审核，已拒绝写入。",
      },
    },
    commentPolicy: {
      enabled: readBoolean(raw.commentPolicy?.enabled, true),
      title: readString(raw.commentPolicy?.title) ?? "今日锐评",
      allowSameDayComment: readBoolean(raw.commentPolicy?.allowSameDayComment, false),
      maxLength: clamp(readNumber(raw.commentPolicy?.maxLength) ?? 2000, 1, 100_000),
    },
    ai: {
      enabled: readBoolean(raw.ai?.enabled, false),
      baseUrl: readString(raw.ai?.baseUrl) ?? "https://api.openai.com/v1",
      apiKeyEnv: readString(raw.ai?.apiKeyEnv) ?? "OPENCLAW_WORKLOG_AI_API_KEY",
      model: readString(raw.ai?.model) ?? "gpt-4o-mini",
      timeoutMs: clamp(readNumber(raw.ai?.timeoutMs) ?? 15000, 1000, 120000),
      polishPrompt: readString(raw.ai?.polishPrompt) ?? "你是工作日志润色助手。你的任务是把工作项润色成适合记账和复盘的短句。必须忠于事实，不要新增原文没有的信息，不要虚构结果，不要夸张，不要写成周报。只返回 JSON。",
      commentPrompt: readString(raw.ai?.commentPrompt) ?? "你是工作日志复盘助手。你的任务是根据当天工作项判断是否值得补一条简短锐评。锐评应客观、具体、克制，偏向风险、取舍、阻塞、经验，不要喊口号，不要空泛总结。只返回 JSON。",
    },
    preview: {
      enabled: readBoolean(raw.preview?.enabled, true),
      host: readString(raw.preview?.host) ?? "127.0.0.1",
      port: clamp(readNumber(raw.preview?.port) ?? 3210, 1, 65535),
      basePath: normalizeBasePath(readString(raw.preview?.basePath) ?? "/worklog-preview"),
      publicBaseUrl: normalizeOptionalUrl(readString(raw.preview?.publicBaseUrl)),
      shareTtlSeconds: clamp(readNumber(raw.preview?.shareTtlSeconds) ?? 86400, 60, 7 * 24 * 60 * 60),
      shareSecretEnv: readString(raw.preview?.shareSecretEnv) ?? "OPENCLAW_WORKLOG_PREVIEW_SHARE_SECRET",
      title: readString(raw.preview?.title) ?? "工作日志预览",
      sessionCookieName: readString(raw.preview?.sessionCookieName) ?? "worklog_preview_session",
    },
    keywords: {
      set: readString(raw.keywords?.set) ?? "工作日志=",
      list: readString(raw.keywords?.list) ?? "工作日志列表",
      current: readString(raw.keywords?.current) ?? "当前工作日志",
      append: readString(raw.keywords?.append) ?? "记工作日志：",
      appendTo: readString(raw.keywords?.appendTo) ?? "记工作日志@",
      auth: readString(raw.keywords?.auth) ?? "工作日志口令：",
    },
  };
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function normalizeBookPath(bookPath: string, dataRoot: string, senderId?: string, key?: string): string {
  return expandTemplate(bookPath, { dataRoot, sender_id: senderId ?? "", key: key ?? "" });
}

export function expandTemplate(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [name, value] of Object.entries(values)) {
    output = output.replaceAll(`{${name}}`, value);
  }
  return expandHome(output);
}

function normalizeBooks(rawBooks: unknown, dataRoot: string): Record<string, WorklogBookConfig> {
  if (!isPlainObject(rawBooks)) {
    return {};
  }

  const entries = Object.entries(rawBooks)
    .map(([key, value]) => {
      if (!isPlainObject(value)) {
        return null;
      }
      const name = readString(value.name) ?? key;
      const bookPath = readString(value.path);
      if (!bookPath) {
        return null;
      }
      return [key, { name, path: normalizeBookPath(bookPath, dataRoot, undefined, key) }] as const;
    })
    .filter((entry): entry is readonly [string, WorklogBookConfig] => Boolean(entry));

  return Object.fromEntries(entries);
}

function normalizeRoutingMode(value: string | null): RuntimeConfig["senderRouting"]["mode"] {
  return value === "by_sender_id" ? "by_sender_id" : "current";
}

function normalizeOptionalUrl(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/worklog-preview";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/worklog-preview";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .map(([key, item]) => {
      const normalized = readString(item);
      return normalized ? ([key, normalized] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  return Object.fromEntries(entries);
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

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

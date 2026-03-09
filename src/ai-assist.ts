import type { RuntimeConfig, WorklogBatchRow, WorklogRow } from "./types.js";
import { WORKLOG_RULES_MARKDOWN } from "./worklog-rules.js";

export type AiAvailability = {
  ok: boolean;
  reason?: string;
};

export type PolishDraftResult = {
  item: string;
  reason: string;
};

export type PolishBatchResult = {
  items: string[];
  reason: string;
};

export type CommentSuggestionResult = {
  shouldAdd: boolean;
  comment: string;
  reason: string;
};

type ChatJsonResponse<T> = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
} & T;

export function getAiAvailability(config: RuntimeConfig): AiAvailability {
  if (!config.ai.enabled) {
    return { ok: false, reason: "当前未启用 AI 助手。" };
  }
  if (!config.ai.model.trim()) {
    return { ok: false, reason: "AI 模型未配置。" };
  }
  const apiKey = process.env[config.ai.apiKeyEnv.trim()];
  if (!apiKey?.trim()) {
    return { ok: false, reason: `环境变量 ${config.ai.apiKeyEnv} 未设置。` };
  }
  return { ok: true };
}

export async function polishWorklogDraft(params: {
  config: RuntimeConfig;
  day: string;
  hours: number;
  item: string;
  sourceText: string;
}): Promise<PolishDraftResult> {
  ensureAiReady(params.config);
  const response = await requestJson<{ item?: string; reason?: string }>({
    config: params.config,
    systemPrompt: params.config.ai.polishPrompt,
    userPrompt: [
      `目标日期：${params.day}`,
      `工时：${params.hours} 小时`,
      `当前工作项：${params.item}`,
      params.sourceText.trim() ? `原始输入：${params.sourceText.trim()}` : "",
      "请只润色工作项文本，不要改动日期和工时。",
      `输出 JSON：{\"item\":\"润色后的工作项\",\"reason\":\"一句话说明\"}`,
      `工作项需简洁、客观、可归档，长度不超过 ${params.config.writeGuard.review.maxItemLength} 字。`,
      "以下规则必须同时满足：",
      WORKLOG_RULES_MARKDOWN,
    ].filter(Boolean).join("\n"),
  });

  const item = normalizeSingleLine(response.item ?? "");
  if (!item) {
    throw new Error("AI 未返回可用的润色结果。");
  }

  return {
    item,
    reason: normalizeSingleLine(response.reason ?? "已按日志风格润色。") || "已按日志风格润色。",
  };
}

export async function polishWorklogBatch(params: {
  config: RuntimeConfig;
  day: string;
  entries: WorklogBatchRow[];
  sourceText: string;
}): Promise<PolishBatchResult> {
  ensureAiReady(params.config);
  const response = await requestJson<{ items?: string[]; reason?: string }>({
    config: params.config,
    systemPrompt: params.config.ai.polishPrompt,
    userPrompt: [
      `目标日期：${params.day}`,
      "当前工作项列表：",
      ...params.entries.map((entry, index) => `${index + 1}. ${entry.item}｜${entry.hours}h`),
      params.sourceText.trim() ? `原始输入：${params.sourceText.trim()}` : "",
      "请只润色每一条工作项文本，不要改动顺序，不要合并拆分，不要改动工时。",
      `输出 JSON：{"items":["第一条润色结果","第二条润色结果"],"reason":"一句话说明"}`,
      `每条工作项都需简洁、客观、可归档，长度不超过 ${params.config.writeGuard.review.maxItemLength} 字。`,
      "以下规则必须同时满足：",
      WORKLOG_RULES_MARKDOWN,
    ].filter(Boolean).join("\n"),
  });

  const items = Array.isArray(response.items)
    ? response.items.map((item) => normalizeSingleLine(String(item ?? ""))).filter(Boolean)
    : [];
  if (!items.length || items.length !== params.entries.length) {
    throw new Error("AI 未返回完整的批量润色结果。");
  }

  return {
    items,
    reason: normalizeSingleLine(response.reason ?? "已按日志风格批量润色。") || "已按日志风格批量润色。",
  };
}

export async function suggestWorklogComment(params: {
  config: RuntimeConfig;
  day: string;
  rows: WorklogRow[];
  existingComment: string | null;
}): Promise<CommentSuggestionResult> {
  ensureAiReady(params.config);
  const rowLines = params.rows.map((row, index) => `${index + 1}. ${row.item}｜${row.hours}h`);
  const response = await requestJson<{ shouldAdd?: boolean; comment?: string; reason?: string }>({
    config: params.config,
    systemPrompt: params.config.ai.commentPrompt,
    userPrompt: [
      `目标日期：${params.day}`,
      params.existingComment ? `当前已有锐评：${params.existingComment}` : "当前还没有锐评。",
      "当日工作项：",
      ...rowLines,
      "请判断是否值得补一条“今日锐评”。",
      `若不建议补写，请返回 shouldAdd=false，并说明原因。若建议补写，comment 需不超过 ${params.config.commentPolicy.maxLength} 字，客观、简洁、可复盘，不要空话套话。`,
      '输出 JSON：{"shouldAdd":true,"comment":"建议锐评","reason":"一句话原因"}',
      "以下规则必须同时满足：",
      WORKLOG_RULES_MARKDOWN,
    ].join("\n"),
  });

  return {
    shouldAdd: Boolean(response.shouldAdd),
    comment: normalizeSingleLine(response.comment ?? ""),
    reason: normalizeSingleLine(response.reason ?? "") || "AI 已完成锐评检测。",
  };
}

function ensureAiReady(config: RuntimeConfig): void {
  const availability = getAiAvailability(config);
  if (!availability.ok) {
    throw new Error(availability.reason ?? "AI 助手当前不可用。");
  }
}

async function requestJson<T>(params: {
  config: RuntimeConfig;
  systemPrompt: string;
  userPrompt: string;
}): Promise<T> {
  const apiKey = process.env[params.config.ai.apiKeyEnv.trim()]?.trim();
  if (!apiKey) {
    throw new Error(`环境变量 ${params.config.ai.apiKeyEnv} 未设置。`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.config.ai.timeoutMs);
  try {
    const response = await fetch(resolveChatCompletionsUrl(params.config.ai.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: params.config.ai.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    const parsed = safeParseJson<ChatJsonResponse<T>>(raw);
    if (!response.ok) {
      throw new Error(parsed?.error?.message || `AI 请求失败：HTTP ${response.status}`);
    }

    const content = extractContent(parsed);
    const contentJson = safeParseJson<T>(content);
    if (contentJson) {
      return contentJson;
    }

    const rawJson = safeParseJson<T>(raw);
    if (rawJson) {
      return rawJson;
    }

    const match = content.match(/\{[\s\S]*\}/u) || raw.match(/\{[\s\S]*\}/u);
    if (match) {
      const embedded = safeParseJson<T>(match[0]);
      if (embedded) {
        return embedded;
      }
    }

    throw new Error("AI 返回内容不是合法 JSON。");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`AI 请求超时（>${params.config.ai.timeoutMs}ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    return "https://api.openai.com/v1/chat/completions";
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function extractContent<T>(payload: ChatJsonResponse<T> | null): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((entry) => typeof entry?.text === "string" ? entry.text : "")
      .join("\n")
      .trim();
  }
  return "";
}

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TelegramPanelTarget {
  chatId: string;
  threadId: number | null;
}

export type TelegramButtonStyle = "primary" | "success" | "danger";

export interface TelegramInlineKeyboardButton {
  text: string;
  style?: TelegramButtonStyle;
  callback_data?: string;
}

export type TelegramReplyMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export interface TelegramPanelMessage {
  text: string;
  replyMarkup?: TelegramReplyMarkup;
}

export class TelegramPanelDelivery {
  private readonly apiBaseUrl: string;
  private readonly botToken: string;
  private readonly requestTimeoutMs: number;
  private readonly proxyUrl: string | null;

  constructor(params: {
    botToken: string;
    apiBaseUrl?: string;
    requestTimeoutMs?: number;
    proxyUrl?: string | null;
  }) {
    this.botToken = params.botToken;
    this.apiBaseUrl = (params.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.requestTimeoutMs = params.requestTimeoutMs ?? 15_000;
    this.proxyUrl = params.proxyUrl ?? null;
  }

  async sendMessage(target: TelegramPanelTarget, message: TelegramPanelMessage): Promise<{ messageId: number }> {
    const result = await this.callTelegram<{ result: { message_id: number } }>("sendMessage", {
      chat_id: normalizeChatId(target.chatId),
      text: message.text,
      ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
    });
    return { messageId: result.result.message_id };
  }

  async editMessage(target: TelegramPanelTarget, messageId: number, message: TelegramPanelMessage): Promise<void> {
    try {
      await this.callTelegram("editMessageText", {
        chat_id: normalizeChatId(target.chatId),
        message_id: messageId,
        text: message.text,
        ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
      });
    } catch (error) {
      if (String(error).includes("message is not modified")) {
        return;
      }
      throw error;
    }
  }

  async deleteMessage(target: TelegramPanelTarget, messageId: number): Promise<void> {
    await this.callTelegram("deleteMessage", {
      chat_id: normalizeChatId(target.chatId),
      message_id: messageId,
    });
  }

  private async callTelegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const args = [
      "-sS",
      "-X", "POST",
      "-H", "content-type: application/json",
      ...(this.proxyUrl ? ["--proxy", this.proxyUrl] : []),
      "--data", JSON.stringify(body),
      `${this.apiBaseUrl}/bot${this.botToken}/${method}`,
    ];

    const { stdout, stderr } = await execFileAsync("curl", args, {
      timeout: this.requestTimeoutMs,
      maxBuffer: 1024 * 1024,
    });

    let payload: { ok?: boolean; description?: string } & T;
    try {
      payload = JSON.parse(stdout) as { ok?: boolean; description?: string } & T;
    } catch {
      throw new Error(`Telegram API ${method} failed: invalid json ${stderr || stdout}`);
    }

    if (payload.ok === false) {
      throw new Error(`Telegram API ${method} failed: ${payload.description ?? "unknown error"}`);
    }
    return payload;
  }
}

export function parseTelegramTarget(raw: string | undefined, fallbackThreadId?: number): TelegramPanelTarget | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const withPrefix = trimmed.match(/^telegram:(-?\d+)(?::topic:(\d+))?$/i);
  if (withPrefix) {
    return {
      chatId: withPrefix[1],
      threadId: normalizeThreadId(withPrefix[2]) ?? normalizeThreadId(fallbackThreadId),
    };
  }

  if (/^-?\d+$/.test(trimmed)) {
    return {
      chatId: trimmed,
      threadId: normalizeThreadId(fallbackThreadId),
    };
  }

  return null;
}

function normalizeChatId(chatId: string): string | number {
  return /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
}

function normalizeThreadId(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

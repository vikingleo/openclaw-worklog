import http from "node:http";

import { authorizeViewerSession, checkReadAccess, locateBookPath, resolveBook } from "./access.js";
import { enforceReadScope } from "./guards.js";
import { renderAuthHtml, renderPreviewHtml } from "./preview-render.js";
import { getEffectiveBooks, loadState } from "./state-store.js";
import type { LoggerLike, RuntimeConfig } from "./types.js";
import { loadMonthDocument } from "./worklog-storage.js";

export class WorklogPreviewService {
  private server: http.Server | null = null;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly logger: LoggerLike,
  ) {}

  async start(): Promise<void> {
    if (!this.config.preview.enabled || this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.logger.error(`[worklog-preview] ${String(error instanceof Error ? error.stack ?? error.message : error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        res.end("预览服务内部错误。");
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server?.once("error", onError);
      this.server?.listen(this.config.preview.port, this.config.preview.host, () => {
        this.server?.off("error", onError);
        resolve();
      });
    });

    this.logger.info(`[worklog-preview] listening on http://${this.config.preview.host}:${this.config.preview.port}${this.config.preview.basePath}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const current = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = normalizePathname(url.pathname);
    const basePath = this.config.preview.basePath;

    if (pathname === `${basePath}/health`) {
      return this.sendJson(res, 200, { status: "ok" });
    }

    if (pathname === basePath || pathname === `${basePath}/` || pathname === `${basePath}/preview`) {
      return this.handlePreview(url, req, res);
    }

    if (pathname === `${basePath}/auth` && req.method === "POST") {
      return this.handleAuth(req, res);
    }

    if (pathname === `${basePath}/raw`) {
      return this.handleRaw(url, req, res);
    }

    this.sendText(res, 404, "预览页面不存在。");
  }

  private async handlePreview(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const senderId = requiredSearchParam(url, "senderId");
    const month = normalizeMonth(url.searchParams.get("month"));
    const requestedBook = normalizeOptional(url.searchParams.get("book"));
    const sessionToken = readCookie(req.headers.cookie, this.config.preview.sessionCookieName);
    const access = checkReadAccess(this.config, senderId, sessionToken);

    if (access.status !== "ok") {
      return this.sendHtml(res, 401, renderAuthHtml({
        title: this.config.preview.title,
        senderId,
        month,
        book: requestedBook ?? undefined,
        authPath: `${this.config.preview.basePath}/auth`,
      }));
    }

    const resolved = resolveBook({ config: this.config, senderId, requestedBook: requestedBook ?? undefined });
    enforceReadScope({ config: this.config, senderId, key: resolved.key });
    const bookPath = locateBookPath(this.config, resolved.key);
    const document = loadMonthDocument({ config: this.config, bookPath, month });
    const books = getEffectiveBooks(this.config, loadState(this.config));
    const rawPath = `${this.config.preview.basePath}/raw?senderId=${encodeURIComponent(senderId)}&month=${encodeURIComponent(month)}&book=${encodeURIComponent(resolved.key)}`;

    return this.sendHtml(res, 200, renderPreviewHtml({
      title: this.config.preview.title,
      senderId,
      bookKey: resolved.key,
      bookName: books[resolved.key]?.name ?? resolved.key,
      month,
      document,
      rawPath,
    }));
  }

  private async handleAuth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const senderId = requiredValue(params.get("senderId"), "senderId");
    const month = normalizeMonth(params.get("month"));
    const requestedBook = normalizeOptional(params.get("book"));
    const password = requiredValue(params.get("password"), "password");
    const auth = authorizeViewerSession(this.config, senderId, password);

    if (auth.result.status !== "ok" || !auth.token || !auth.expiresAt) {
      return this.sendHtml(res, 401, renderAuthHtml({
        title: this.config.preview.title,
        senderId,
        month,
        book: requestedBook ?? undefined,
        authPath: `${this.config.preview.basePath}/auth`,
        error: auth.result.message === "invalid-password" ? "口令不对，别瞎试。" : "浏览口令暂不可用。",
      }));
    }

    const cookieMaxAge = Math.max(60, auth.expiresAt - Math.floor(Date.now() / 1000));
    res.setHeader("Set-Cookie", `${this.config.preview.sessionCookieName}=${auth.token}; Path=${this.config.preview.basePath}; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAge}`);
    res.writeHead(302, {
      Location: `${this.config.preview.basePath}?senderId=${encodeURIComponent(senderId)}&month=${encodeURIComponent(month)}${requestedBook ? `&book=${encodeURIComponent(requestedBook)}` : ""}`,
    });
    res.end();
  }

  private async handleRaw(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const senderId = requiredSearchParam(url, "senderId");
    const month = normalizeMonth(url.searchParams.get("month"));
    const requestedBook = normalizeOptional(url.searchParams.get("book"));
    const sessionToken = readCookie(req.headers.cookie, this.config.preview.sessionCookieName);
    const access = checkReadAccess(this.config, senderId, sessionToken);

    if (access.status !== "ok") {
      return this.sendText(res, 401, "未授权读取该日志。", "text/plain; charset=utf-8");
    }

    const resolved = resolveBook({ config: this.config, senderId, requestedBook: requestedBook ?? undefined });
    enforceReadScope({ config: this.config, senderId, key: resolved.key });
    const bookPath = locateBookPath(this.config, resolved.key);
    const document = loadMonthDocument({ config: this.config, bookPath, month });
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `inline; filename="${encodeURIComponent(`${month}.md`)}"`,
    });
    res.end(document.rawContent);
  }

  private sendHtml(res: http.ServerResponse, status: number, html: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private sendText(res: http.ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }
}

function normalizePathname(input: string): string {
  const normalized = input.replace(/\/+$/, "");
  return normalized || "/";
}

function normalizeMonth(value: string | null): string {
  const month = (value ?? currentMonth()).trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("月份必须是 YYYY-MM。");
  }
  return month;
}

function currentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function requiredSearchParam(url: URL, name: string): string {
  const value = normalizeOptional(url.searchParams.get(name));
  if (!value) {
    throw new Error(`缺少参数：${name}`);
  }
  return value;
}

function requiredValue(value: string | null, name: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    throw new Error(`缺少参数：${name}`);
  }
  return normalized;
}

function normalizeOptional(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  const pairs = header.split(/;\s*/);
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key === name) {
      return value || null;
    }
  }
  return null;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

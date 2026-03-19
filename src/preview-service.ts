import http from "node:http";
import fs from "node:fs";

import { authorizeViewerSession, checkReadAccess, locateBookPath, resolveBook } from "./access.js";
import {
  buildPersistentPreviewUrl,
  buildPersistentRawUrl,
  buildSignedPreviewUrl,
  buildSignedRawUrl,
  ensurePersistentShare,
  getPersistentShare,
  revokePersistentShare,
  verifyPersistentWorklogAccess,
  verifySignedWorklogAccess,
} from "./preview-share.js";
import { enforceReadScope } from "./guards.js";
import { renderAuthHtml, renderLandingHtml, renderPreviewHtml } from "./preview-render.js";
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
        if (error instanceof BadRequestError) {
          if (!res.headersSent) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          }
          res.end(error.message);
          return;
        }

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

    if (pathname === "/" || pathname === "") {
      return this.sendHtml(res, 200, renderLandingHtml({
        title: this.config.preview.title,
        previewPath: basePath,
        defaultMonth: currentMonth(),
      }));
    }

    if (pathname === `${basePath}/health`) {
      return this.sendJson(res, 200, { status: "ok" });
    }

    if (pathname === basePath || pathname === `${basePath}/` || pathname === `${basePath}/preview`) {
      return this.handlePreview(url, req, res);
    }

    if (pathname === `${basePath}/auth` && req.method === "POST") {
      return this.handleAuth(req, res);
    }

    if (pathname === `${basePath}/jump` && req.method === "POST") {
      return this.handleJump(req, res);
    }

    if (pathname === `${basePath}/share` && req.method === "POST") {
      return this.handleShare(req, res);
    }

    if (pathname === `${basePath}/raw`) {
      return this.handleRaw(url, req, res);
    }

    this.sendText(res, 404, "预览页面不存在。");
  }

  private async handlePreview(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const month = normalizeMonth(url.searchParams.get("month"));
    const shareToken = normalizeOptional(url.searchParams.get("share"));
    const shared = verifyPersistentWorklogAccess({ config: this.config, shareToken });
    if (shared && !shared.ok) {
      return this.sendText(res, 403, shared.reason);
    }

    let senderId = shared && shared.ok ? shared.senderId : requiredSearchParam(url, "senderId");
    let requestedBook = shared && shared.ok ? shared.book : normalizeOptional(url.searchParams.get("book"));
    const expRaw = shared && shared.ok ? null : normalizeOptional(url.searchParams.get("exp"));
    const sigRaw = shared && shared.ok ? null : normalizeOptional(url.searchParams.get("sig"));
    const signed = shared
      ? null
      : verifySignedWorklogAccess({
        config: this.config,
        senderId,
        month,
        book: requestedBook,
        expRaw,
        sigRaw,
        mode: "preview",
      });
    if (signed && !signed.ok) {
      return this.sendText(res, 403, signed.reason);
    }

    if (!shared && !signed) {
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
    }

    const resolved = resolveBook({ config: this.config, senderId, requestedBook: requestedBook ?? undefined });
    enforceReadScope({ config: this.config, senderId, key: resolved.key });
    const bookPath = locateBookPath(this.config, resolved.key);
    const document = loadMonthDocument({ config: this.config, bookPath, month });
    const books = getEffectiveBooks(this.config, loadState(this.config));
    const currentShare = shared
      ? null
      : getPersistentShare(this.config, senderId, resolved.key);
    const buildPreviewTarget = (targetMonth: string) => (
      shared && shared.ok
        ? buildPersistentPreviewUrl(this.config, shared.token, targetMonth)
        : signed
          ? buildSignedPreviewUrl(this.config, senderId, targetMonth, resolved.key)
          : buildPreviewPath(this.config.preview.basePath, senderId, targetMonth, resolved.key)
    );
    const fileNav = buildMonthFileNavigation(bookPath, month, buildPreviewTarget);
    const rawPath = shared && shared.ok
      ? buildPersistentRawUrl(this.config, shared.token, month)
      : signed
        ? buildSignedRawUrl(this.config, senderId, month, resolved.key)
        : buildRawPath(this.config.preview.basePath, senderId, month, resolved.key);

    return this.sendHtml(res, 200, renderPreviewHtml({
      title: this.config.preview.title,
      senderId,
      bookKey: resolved.key,
      bookName: books[resolved.key]?.name ?? resolved.key,
      month,
      document,
      rawPath,
      prevFilePath: fileNav.prevPath,
      nextFilePath: fileNav.nextPath,
      fileOptions: fileNav.options,
      monthJumpPath: `${this.config.preview.basePath}/jump`,
      shareActionPath: shared || signed ? undefined : `${this.config.preview.basePath}/share`,
      shareUrl: currentShare ? buildPersistentPreviewUrl(this.config, currentShare.token, month) : undefined,
      sharedView: Boolean(shared),
      signedExp: signed ? expRaw ?? undefined : undefined,
      signedSig: signed ? sigRaw ?? undefined : undefined,
      shareToken: shared && shared.ok ? shared.token : undefined,
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
      Location: buildPreviewPath(this.config.preview.basePath, senderId, month, requestedBook ?? undefined),
    });
    res.end();
  }

  private async handleJump(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const month = normalizeMonth(params.get("month"));
    const sourceMonth = normalizeMonth(params.get("sourceMonth"));
    const shareToken = normalizeOptional(params.get("share"));
    const shared = verifyPersistentWorklogAccess({ config: this.config, shareToken });
    if (shared && !shared.ok) {
      return this.sendText(res, 403, shared.reason);
    }
    if (shared && shared.ok) {
      res.writeHead(302, {
        Location: buildPersistentPreviewUrl(this.config, shared.token, month),
      });
      res.end();
      return;
    }

    const senderId = requiredValue(params.get("senderId"), "senderId");
    const requestedBook = normalizeOptional(params.get("book"));
    const expRaw = normalizeOptional(params.get("exp"));
    const sigRaw = normalizeOptional(params.get("sig"));
    const hasSignedPayload = Boolean(expRaw || sigRaw);

    if (hasSignedPayload) {
      const signed = verifySignedWorklogAccess({
        config: this.config,
        senderId,
        month: sourceMonth,
        book: requestedBook,
        expRaw,
        sigRaw,
        mode: "preview",
      });
      if (!signed || !signed.ok) {
        return this.sendText(res, 403, signed ? signed.reason : "缺少签名参数。");
      }
      res.writeHead(302, {
        Location: buildSignedPreviewUrl(this.config, senderId, month, requestedBook ?? undefined),
      });
      res.end();
      return;
    }

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

    res.writeHead(302, {
      Location: buildPreviewPath(this.config.preview.basePath, senderId, month, requestedBook ?? undefined),
    });
    res.end();
  }

  private async handleShare(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const action = requiredValue(params.get("action"), "action");
    const senderId = requiredValue(params.get("senderId"), "senderId");
    const month = normalizeMonth(params.get("month"));
    const requestedBook = requiredValue(params.get("book"), "book");
    const sessionToken = readCookie(req.headers.cookie, this.config.preview.sessionCookieName);
    const access = checkReadAccess(this.config, senderId, sessionToken);
    if (access.status !== "ok") {
      return this.sendHtml(res, 401, renderAuthHtml({
        title: this.config.preview.title,
        senderId,
        month,
        book: requestedBook,
        authPath: `${this.config.preview.basePath}/auth`,
      }));
    }

    const resolved = resolveBook({ config: this.config, senderId, requestedBook });
    if (action === "open") {
      ensurePersistentShare(this.config, senderId, resolved.key);
    } else if (action === "close") {
      revokePersistentShare(this.config, senderId, resolved.key);
    } else {
      return this.sendText(res, 400, "分享操作无效。");
    }

    res.writeHead(302, {
      Location: buildPreviewPath(this.config.preview.basePath, senderId, month, resolved.key),
    });
    res.end();
  }

  private async handleRaw(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const month = normalizeMonth(url.searchParams.get("month"));
    const shareToken = normalizeOptional(url.searchParams.get("share"));
    const shared = verifyPersistentWorklogAccess({ config: this.config, shareToken });
    if (shared && !shared.ok) {
      return this.sendText(res, 403, shared.reason, "text/plain; charset=utf-8");
    }

    let senderId = shared && shared.ok ? shared.senderId : requiredSearchParam(url, "senderId");
    let requestedBook = shared && shared.ok ? shared.book : normalizeOptional(url.searchParams.get("book"));
    const signed = shared
      ? null
      : verifySignedWorklogAccess({
        config: this.config,
        senderId,
        month,
        book: requestedBook,
        expRaw: normalizeOptional(url.searchParams.get("exp")),
        sigRaw: normalizeOptional(url.searchParams.get("sig")),
        mode: "raw",
      });
    if (signed && !signed.ok) {
      return this.sendText(res, 403, signed.reason, "text/plain; charset=utf-8");
    }

    if (!shared && !signed) {
      const sessionToken = readCookie(req.headers.cookie, this.config.preview.sessionCookieName);
      const access = checkReadAccess(this.config, senderId, sessionToken);
      if (access.status !== "ok") {
        return this.sendText(res, 401, "未授权读取该日志。", "text/plain; charset=utf-8");
      }
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

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

function normalizePathname(input: string): string {
  const normalized = input.replace(/\/+$/, "");
  return normalized || "/";
}

function normalizeMonth(value: string | null): string {
  const month = (value ?? currentMonth()).trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new BadRequestError("月份必须是 YYYY-MM。");
  }
  return month;
}

function currentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function buildMonthFileNavigation(
  bookPath: string,
  currentMonth: string,
  buildPath: (month: string) => string,
): {
  prevPath?: string;
  nextPath?: string;
  options: Array<{ label: string; path: string; current: boolean }>;
} {
  const months = new Set<string>();
  for (const entry of listMonthFiles(bookPath)) {
    months.add(entry);
  }
  months.add(currentMonth);
  const ordered = Array.from(months).sort();
  const currentIndex = ordered.indexOf(currentMonth);
  return {
    prevPath: currentIndex > 0 ? buildPath(ordered[currentIndex - 1]) : undefined,
    nextPath: currentIndex >= 0 && currentIndex < ordered.length - 1 ? buildPath(ordered[currentIndex + 1]) : undefined,
    options: ordered.map((month) => ({
      label: `${month}.md`,
      path: buildPath(month),
      current: month === currentMonth,
    })),
  };
}

function listMonthFiles(bookPath: string): string[] {
  try {
    return fs.readdirSync(bookPath)
      .filter((name) => /^\d{4}-\d{2}\.md$/i.test(name))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function buildPreviewPath(basePath: string, senderId: string, month: string, book?: string): string {
  const params = new URLSearchParams();
  params.set("senderId", senderId);
  params.set("month", month);
  if (book?.trim()) {
    params.set("book", book.trim());
  }
  return `${basePath}?${params.toString()}`;
}

function buildRawPath(basePath: string, senderId: string, month: string, book?: string): string {
  const params = new URLSearchParams();
  params.set("senderId", senderId);
  params.set("month", month);
  if (book?.trim()) {
    params.set("book", book.trim());
  }
  return `${basePath}/raw?${params.toString()}`;
}

function requiredSearchParam(url: URL, name: string): string {
  const value = normalizeOptional(url.searchParams.get(name));
  if (!value) {
    throw new BadRequestError(`缺少参数：${name}`);
  }
  return value;
}

function requiredValue(value: string | null, name: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    throw new BadRequestError(`缺少参数：${name}`);
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

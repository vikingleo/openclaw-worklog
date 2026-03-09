import os from "node:os";

import type { RuntimeConfig } from "./types.js";

export function buildUnsignedPreviewUrl(config: RuntimeConfig, senderId: string, month: string, book?: string): string {
  const base = resolvePreviewBaseUrl(config);
  const url = new URL(base);
  url.searchParams.set("senderId", senderId);
  url.searchParams.set("month", month);
  if (book?.trim()) {
    url.searchParams.set("book", book.trim());
  }
  return url.toString();
}

export function resolvePreviewBaseUrl(config: RuntimeConfig): string {
  const explicit = config.preview.publicBaseUrl?.trim();
  if (explicit) {
    return `${explicit}${config.preview.basePath}`;
  }
  const envBase = process.env.OPENCLAW_WORKLOG_PREVIEW_PUBLIC_BASE_URL?.trim();
  if (envBase) {
    return `${envBase.replace(/\/+$/, "")}${config.preview.basePath}`;
  }
  const envHost = process.env.OPENCLAW_WORKLOG_PREVIEW_PUBLIC_HOST?.trim();
  if (envHost) {
    return `http://${envHost}:${config.preview.port}${config.preview.basePath}`;
  }
  const host = resolvePreviewPublicHost(config.preview.host);
  return `http://${host}:${config.preview.port}${config.preview.basePath}`;
}

function resolvePreviewPublicHost(host: string): string {
  const trimmed = host.trim();
  if (!["0.0.0.0", "::", "::0", "[::]"].includes(trimmed)) {
    return trimmed;
  }
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

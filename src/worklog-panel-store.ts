import crypto from "node:crypto";
import fs from "node:fs";

import { ensureParentDir } from "./config.js";

export interface WorklogPanelRecord {
  panelId: string;
  chatId: string;
  threadId: number | null;
  ownerSenderId: string;
  messageId: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

interface WorklogPanelStateFile {
  version: 1;
  panels: Record<string, WorklogPanelRecord>;
}

export class WorklogPanelStore {
  private readonly stateFile: string;
  private readonly panels = new Map<string, WorklogPanelRecord>();

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.load();
  }

  get(panelId: string): WorklogPanelRecord | undefined {
    return this.panels.get(panelId);
  }

  delete(panelId: string): WorklogPanelRecord | undefined {
    const record = this.panels.get(panelId);
    if (!record) {
      return undefined;
    }
    this.panels.delete(panelId);
    this.save();
    return record;
  }

  create(params: { chatId: string; threadId: number | null; ownerSenderId: string }): WorklogPanelRecord {
    const now = Date.now();
    const record: WorklogPanelRecord = {
      panelId: crypto.randomUUID(),
      chatId: params.chatId,
      threadId: params.threadId,
      ownerSenderId: params.ownerSenderId,
      messageId: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.panels.set(record.panelId, record);
    this.save();
    return record;
  }

  update(panelId: string, updater: (current: WorklogPanelRecord) => WorklogPanelRecord): WorklogPanelRecord | undefined {
    const current = this.panels.get(panelId);
    if (!current) {
      return undefined;
    }
    const next = updater(current);
    this.panels.set(panelId, next);
    this.save();
    return next;
  }

  findByOwnerChat(ownerSenderId: string, chatId: string, threadId: number | null): WorklogPanelRecord | undefined {
    const rows = [...this.panels.values()]
      .filter((record) => record.ownerSenderId === ownerSenderId && record.chatId === chatId && record.threadId === threadId)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    return rows[0];
  }

  purgeExpired(isExpired: (record: WorklogPanelRecord) => boolean): WorklogPanelRecord[] {
    const staleRecords = [...this.panels.values()].filter((record) => isExpired(record));
    if (!staleRecords.length) {
      return [];
    }

    for (const record of staleRecords) {
      this.panels.delete(record.panelId);
    }
    this.save();
    return staleRecords;
  }

  private load(): void {
    if (!fs.existsSync(this.stateFile)) {
      return;
    }
    const raw = fs.readFileSync(this.stateFile, "utf8");
    const parsed = JSON.parse(raw) as WorklogPanelStateFile;
    if (parsed.version !== 1 || !parsed.panels || typeof parsed.panels !== "object") {
      return;
    }
    for (const record of Object.values(parsed.panels)) {
      this.panels.set(record.panelId, record);
    }
  }

  private save(): void {
    ensureParentDir(this.stateFile);
    const payload: WorklogPanelStateFile = {
      version: 1,
      panels: Object.fromEntries(this.panels.entries()),
    };
    const tempFile = `${this.stateFile}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempFile, this.stateFile);
  }
}

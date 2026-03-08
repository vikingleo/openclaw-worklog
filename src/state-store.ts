import fs from "node:fs";
import path from "node:path";

import { ensureParentDir } from "./config.js";
import type { ReadSessionRecord, RuntimeConfig, RuntimeState, WorklogBookConfig, WorklogInputState } from "./types.js";

export function loadState(config: RuntimeConfig): RuntimeState {
  if (!fs.existsSync(config.stateFile)) {
    return emptyState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(config.stateFile, "utf8")) as RuntimeState;
    return {
      currentBook: parsed.currentBook,
      books: parsed.books ?? {},
      senderBindings: parsed.senderBindings ?? {},
      readSessions: parsed.readSessions ?? {},
      inputStates: parsed.inputStates ?? {},
    };
  } catch {
    return emptyState();
  }
}

export function saveState(config: RuntimeConfig, state: RuntimeState): void {
  ensureParentDir(config.stateFile);
  fs.writeFileSync(config.stateFile, `${JSON.stringify(cleanState(state), null, 2)}\n`, "utf8");
}

export function getEffectiveBooks(config: RuntimeConfig, state: RuntimeState): Record<string, WorklogBookConfig> {
  return {
    ...config.books,
    ...(state.books ?? {}),
  };
}

export function getEffectiveBindings(config: RuntimeConfig, state: RuntimeState): Record<string, string> {
  return {
    ...config.senderRouting.bindings,
    ...(state.senderBindings ?? {}),
  };
}

export function getEffectiveCurrentBook(config: RuntimeConfig, state: RuntimeState): string | null {
  return state.currentBook ?? config.currentBook ?? config.defaultBook ?? null;
}

export function ensureBookDir(book: WorklogBookConfig): void {
  fs.mkdirSync(path.resolve(book.path), { recursive: true });
}

function cleanState(state: RuntimeState): RuntimeState {
  return {
    ...(state.currentBook ? { currentBook: state.currentBook } : {}),
    ...(state.books && Object.keys(state.books).length ? { books: state.books } : {}),
    ...(state.senderBindings && Object.keys(state.senderBindings).length ? { senderBindings: state.senderBindings } : {}),
    ...(state.readSessions && Object.keys(state.readSessions).length ? { readSessions: state.readSessions } : {}),
    ...(state.inputStates && Object.keys(state.inputStates).length ? { inputStates: state.inputStates } : {}),
  };
}

function emptyState(): RuntimeState {
  return {
    books: {},
    senderBindings: {},
    readSessions: {},
    inputStates: {},
  };
}

export function purgeExpiredSessions(state: RuntimeState, nowTs: number): boolean {
  const sessions = state.readSessions ?? {};
  const staleKeys = Object.entries(sessions)
    .filter(([, record]) => Number(record.expiresAt) <= nowTs)
    .map(([token]) => token);

  if (!staleKeys.length) {
    return false;
  }

  for (const token of staleKeys) {
    delete sessions[token];
  }
  return true;
}

export function setSession(state: RuntimeState, token: string, record: ReadSessionRecord): void {
  state.readSessions ??= {};
  state.readSessions[token] = record;
}

export function makeInputStateKey(channel: string, senderId: string): string {
  return `${channel}:${senderId}`;
}

export function getInputState(state: RuntimeState, channel: string, senderId: string): WorklogInputState | null {
  return state.inputStates?.[makeInputStateKey(channel, senderId)] ?? null;
}

export function setInputState(state: RuntimeState, channel: string, senderId: string, inputState: WorklogInputState): void {
  state.inputStates ??= {};
  state.inputStates[makeInputStateKey(channel, senderId)] = inputState;
}

export function clearInputState(state: RuntimeState, channel: string, senderId: string): void {
  if (!state.inputStates) {
    return;
  }
  delete state.inputStates[makeInputStateKey(channel, senderId)];
}

export function purgeExpiredInputStates(state: RuntimeState, nowTsMs: number): boolean {
  const inputStates = state.inputStates ?? {};
  const staleKeys = Object.entries(inputStates)
    .filter(([, record]) => Number(record.expiresAt) <= nowTsMs)
    .map(([key]) => key);

  if (!staleKeys.length) {
    return false;
  }

  for (const key of staleKeys) {
    delete inputStates[key];
  }
  return true;
}

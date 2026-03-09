export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface WorklogBookConfig {
  name: string;
  path: string;
}

export interface SenderRoutingConfig {
  mode: "current" | "by_sender_id";
  autoCreate: boolean;
  bookKeyPrefix: string;
  nameTemplate: string;
  bookPathTemplate: string;
  allowAutoBindSenders: string[];
  bindings: Record<string, string>;
}

export interface ReadAccessConfig {
  requirePasswordForNonAdminRead: boolean;
  viewerPasswordEnv: string;
  viewerPasswordEnvFile: string | null;
  sessionTtlMinutes: number;
  adminSenderIds: string[];
}

export interface ReviewConfig {
  trimWhitespace: boolean;
  maxItemLength: number;
  forbiddenPatterns: string[];
  forbiddenMessage: string;
}

export interface WriteGuardConfig {
  enabled: boolean;
  adminSenderIds: string[];
  restrictedPathPrefix: string | null;
  denyFileUpload: boolean;
  review: ReviewConfig;
}

export interface CommentPolicyConfig {
  enabled: boolean;
  title: string;
  allowSameDayComment: boolean;
  maxLength: number;
}

export interface AiAssistConfig {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  timeoutMs: number;
  polishPrompt: string;
  commentPrompt: string;
}

export interface PreviewConfig {
  enabled: boolean;
  host: string;
  port: number;
  basePath: string;
  publicBaseUrl: string | null;
  shareTtlSeconds: number;
  shareSecretEnv: string;
  title: string;
  sessionCookieName: string;
}

export interface WorklogKeywordsConfig {
  set: string;
  list: string;
  current: string;
  append: string;
  appendTo: string;
  auth: string;
}

export interface RuntimeConfig {
  enabled: boolean;
  dataRoot: string;
  stateFile: string;
  defaultBook: string | null;
  currentBook: string | null;
  monthlyTargetHours: number;
  books: Record<string, WorklogBookConfig>;
  senderRouting: SenderRoutingConfig;
  readAccess: ReadAccessConfig;
  writeGuard: WriteGuardConfig;
  commentPolicy: CommentPolicyConfig;
  ai: AiAssistConfig;
  preview: PreviewConfig;
  keywords: WorklogKeywordsConfig;
}

export interface ReadSessionRecord {
  sender: string;
  createdAt: number;
  expiresAt: number;
}

export type WorklogInputState =
  | {
    mode: "awaiting_item_for_hours";
    presetHours: number;
    createdAt: number;
    expiresAt: number;
  }
  | {
    mode: "awaiting_append_confirm";
    day: string;
    hours: number;
    item: string;
    sourceText: string;
    createdAt: number;
    expiresAt: number;
  }
  | {
    mode: "awaiting_entry_replace";
    day: string;
    rowIndex: number;
    currentHours: number;
    currentItem: string;
    createdAt: number;
    expiresAt: number;
  }
  | {
    mode: "awaiting_comment_confirm";
    day: string;
    comment: string;
    source: "manual" | "ai";
    createdAt: number;
    expiresAt: number;
  };

export interface RuntimeState {
  currentBook?: string;
  books?: Record<string, WorklogBookConfig>;
  senderBindings?: Record<string, string>;
  readSessions?: Record<string, ReadSessionRecord>;
  inputStates?: Record<string, WorklogInputState>;
}

export interface WorklogRow {
  item: string;
  hours: number;
}

export interface DaySection {
  day: string;
  start: number;
  end: number;
  rows: WorklogRow[];
  comment: string | null;
}

export interface MonthDocument {
  month: string;
  file: string;
  title: string;
  summaryLine: string | null;
  sections: DaySection[];
  rawContent: string;
}

export interface AccessResult {
  status: string;
  message: string;
  isAdmin: boolean;
  requiresPassword: boolean;
}

declare module "openclaw/plugin-sdk" {
  export type TelegramInlineKeyboardButton = {
    text: string;
    callback_data: string;
    style?: "primary" | "success" | "danger";
  };

  export type ReplyPayload = {
    text?: string;
    isError?: boolean;
    channelData?: {
      telegram?: {
        buttons?: TelegramInlineKeyboardButton[][];
      };
      [key: string]: unknown;
    };
  };

  export type PluginCommandContext = {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: Record<string, unknown>;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: number;
  };

  export interface OpenClawPluginServiceContext {
    config: Record<string, unknown>;
    workspaceDir?: string;
    stateDir: string;
    logger: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
      debug?(message: string): void;
    };
  }

  export interface OpenClawPluginCliContext {
    program: any;
    config: Record<string, unknown>;
    workspaceDir?: string;
    logger: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
      debug?(message: string): void;
    };
  }

  export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    logger: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
      debug?(message: string): void;
    };
    registerService(service: {
      id: string;
      start(ctx: OpenClawPluginServiceContext): void | Promise<void>;
      stop?(ctx: OpenClawPluginServiceContext): void | Promise<void>;
    }): void;
    registerCli(
      registrar: (ctx: OpenClawPluginCliContext) => void | Promise<void>,
      opts?: { commands?: string[] },
    ): void;
    registerCommand(command: {
      name: string;
      description: string;
      acceptsArgs?: boolean;
      requireAuth?: boolean;
      handler(ctx: PluginCommandContext): ReplyPayload | Promise<ReplyPayload>;
    }): void;
  }
}

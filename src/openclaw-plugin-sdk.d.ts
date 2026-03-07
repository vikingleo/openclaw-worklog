declare module "openclaw/plugin-sdk" {
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
  }
}

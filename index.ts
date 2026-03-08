import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

import { buildRuntimeConfigFromPlugin } from "./src/config.js";
import { registerWorklogChatCommands } from "./src/chat-commands.js";
import { registerWorklogCli } from "./src/plugin-cli.js";
import { WorklogPreviewService } from "./src/preview-service.js";

let previewService: WorklogPreviewService | null = null;

const plugin = {
  id: "worklog",
  name: "工作日志账本",
  description: "多人分账、按月 Markdown 落盘的工作日志插件。",
  register(api: OpenClawPluginApi) {
    registerWorklogChatCommands(api);

    api.registerCli(
      ({ program }) => {
        registerWorklogCli({
          program,
          openclawConfig: api.config as Record<string, unknown>,
          pluginConfig: api.pluginConfig,
          logger: {
            info: (message) => api.logger.info(message),
            warn: (message) => api.logger.warn(message),
            error: (message) => api.logger.error(message),
            debug: (message) => api.logger.debug?.(message),
          },
        });
      },
      { commands: ["worklog"] },
    );

    api.registerService({
      id: "worklog-preview",
      start: async (_ctx: OpenClawPluginServiceContext) => {
        if (previewService) {
          return;
        }

        const config = buildRuntimeConfigFromPlugin({
          openclawConfig: api.config as Record<string, unknown>,
          pluginConfig: api.pluginConfig,
        });
        previewService = new WorklogPreviewService(config, {
          info: (message) => api.logger.info(message),
          warn: (message) => api.logger.warn(message),
          error: (message) => api.logger.error(message),
          debug: (message) => api.logger.debug?.(message),
        });
        await previewService.start();
      },
      stop: async () => {
        await previewService?.stop();
        previewService = null;
      },
    });
  },
};

export default plugin;

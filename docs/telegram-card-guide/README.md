# Telegram Card Guide

这组文档用于指导 `openclaw-worklog` 的 Telegram 卡片式交互开发，但有一个前提要先说清：

- 当前仓库已经具备的核心能力是：日志本解析、日志写入、查询、预览、权限控制、CLI。
- 当前仓库**还没有成熟的 Telegram 卡片交互层**。
- 所以这组文档的目标，不是空口画整套新产品，而是给后续开发一条**贴着现有代码结构走的最小落地路线**。

## 当前源码边界

建议开发时优先围绕这些文件思考，而不是另起一套逻辑：

- `index.ts`
- `src/config.ts`
- `src/state-store.ts`
- `src/access.ts`
- `src/guards.ts`
- `src/worklog-storage.ts`
- `src/types.ts`

## 现有文本命令口径

当前插件配置中已存在的关键词是：

- `工作日志=`
- `工作日志列表`
- `当前工作日志`
- `记工作日志：`
- `记工作日志@`
- `工作日志口令：`

因此：

- `工作日志`、`/worklog` 可以作为**新增入口别名**来规划。
- `查看本月工时`、`生成今日锐评`、`重命名日志本：xxx` 这类写法，不能默认当成“现成已存在命令”，除非开发时同步补上解析。

## 文档分工

- `openclaw-worklog-telegram-card-plan.md`
  - 总体方案，重点讲清边界、目标、非目标、架构约束。
- `openclaw-worklog-telegram-card-task-breakdown.md`
  - 面向开发落地的任务拆分与验收标准。
- `openclaw-worklog-telegram-card-callback-map.md`
  - callback 协议与页面/动作映射，强调 Telegram 64 字节限制。
- `openclaw-worklog-telegram-card-phase-plan.md`
  - 一期 / 二期 / 三期的范围切分，避免首版做炸。

## 推荐阅读顺序

1. 先看 `openclaw-worklog-telegram-card-plan.md`
2. 再看 `openclaw-worklog-telegram-card-callback-map.md`
3. 开发时对照 `openclaw-worklog-telegram-card-task-breakdown.md`
4. 排期时参考 `openclaw-worklog-telegram-card-phase-plan.md`

## 使用原则

- 一期只做 Telegram 高价值主链路，不顺手扩管理后台。
- 按钮交互层只做路由和状态管理，业务逻辑必须复用现有 service / storage。
- 先保证“能记、能看、能查”，再谈编辑、删除、日志本管理。

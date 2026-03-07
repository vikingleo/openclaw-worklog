# OpenClaw Worklog

一个标准、可移植的 OpenClaw 工作日志插件：按“人 / sender”自动分账本，按月写入 Markdown，支持工时累计、重复项去重、阅读授权、在线预览和补写锐评。

## 适合什么场景

- 一套 OpenClaw，同时给多人分别记工时。
- 每个人自己的日志本独立落盘，不串账。
- 只保留 Markdown 月文件，不再依赖旧式表格账本。
- 需要把“写入规则、授权规则、目录结构、预览入口”一起打包成可迁移插件。

## 核心原理

### 1. 按 sender 路由到日志本

插件支持两种模式：

- `current`：所有写入都走当前默认日志本。
- `by_sender_id`：根据消息发送者标识路由到对应日志本。

在 `by_sender_id` 模式下：

- 已绑定 sender：直接写入绑定日志本。
- 未绑定 sender 且命中白名单：自动创建并绑定新日志本。
- 未绑定 sender 且不在白名单：拒绝写入。

这样就能天然支持“多人分开记录工时”。

### 2. 按月落盘 Markdown

每个日志本目录下，按月生成文件：

- `YYYY-MM.md`

文件结构固定：

- 月标题
- 月度工时汇总
- 每天一个分节
- 每天一张工时表
- 可选的“今日锐评”块

示例：

```md
# 2026-03 工作日志
> 本月工时：3.5h / 176h（目标工时），消耗占比：1.99%

## 2026-03-07（总工时：3.5小时）
| 工作项 | 工时（h） |
|---|---:|
| 1. 修复筛选状态回显异常 | 1.5 |
| 2. 调整部署脚本重试逻辑 | 2 |

### 今日锐评

> 这天主要在补坑，但坑至少补平了。
```

### 3. 追加写入，不篡改原意

插件不会替你“擅自升华”工作项：

- 只做必要的空白标准化。
- 不会自动加“已完成”“已上线”之类装腔结论。
- 同一天内命中同名工作项时，默认 `skipped`，避免重复记账。

### 4. 锐评单独维护

锐评和工时写入分离：

- 工时走 `append`
- 锐评走 `comment`

默认不允许给“今天”补锐评，避免边干活边上价值；历史日期可以补。

### 5. 读写安全拆开管

写入安全：

- 非管理员只能写自己绑定的日志本。
- 可限制写入目录前缀。
- 可启用内容审核规则，拦截危险文本。

读取安全：

- 管理员直接读取。
- 非管理员可通过口令换取临时读取会话。
- 非管理员读取时仅允许定位自己绑定的日志本。
- 读取授权状态保存在插件状态文件中。

### 6. 在线预览怎么工作

插件内置一个轻量 HTTP 预览服务：

- 预览服务启动后，监听 `preview.host + preview.port + preview.basePath`
- 管理员访问时可直接查看指定 sender 的月度日志
- 非管理员首次访问会先看到口令页
- 口令正确后，服务写入一个短期 Cookie，会话有效期与 `readAccess.sessionTtlMinutes` 一致
- 预览页会把月度日志解析成中文页面，同时提供原始 Markdown 下载入口

这意味着工作日志插件现在不是“只会记账的内核”，而是“记账 + 鉴权 + 预览”一体化插件。

## 插件结构

- `index.ts`：插件入口
- `openclaw.plugin.json`：插件声明与配置模式
- `src/config.ts`：配置归一化
- `src/access.ts`：sender 路由与读取授权
- `src/guards.ts`：写入审查与范围限制
- `src/worklog-storage.ts`：Markdown 解析与落盘
- `src/preview-service.ts`：在线预览 HTTP 服务
- `src/preview-render.ts`：预览页面渲染
- `src/plugin-cli.ts`：CLI 命令注册
- `config/plugin-config.example.json5`：脱敏示例配置

## 安装方式

把插件目录放到 OpenClaw 可加载的位置后，在宿主配置里启用插件，并填入插件配置。示例配置见：

- `config/plugin-config.example.json5:1`

## 常用命令

### 查看状态

```bash
openclaw worklog status
openclaw worklog books
openclaw worklog current
```

### 切换当前日志本

```bash
openclaw worklog switch --book u-telegram-your-user-id
```

### 解析 sender 对应日志本

```bash
openclaw worklog resolve --sender-id telegram:YOUR_USER_ID
```

### 追加工时

```bash
openclaw worklog append \
  --sender-id telegram:YOUR_USER_ID \
  --item "修复筛选状态回显异常" \
  --hours 1.5
```

指定日期或显式指定日志本：

```bash
openclaw worklog append \
  --sender-id telegram:YOUR_USER_ID \
  --book project-alpha \
  --day 2026-03-06 \
  --item "排查自动部署失败原因" \
  --hours 2
```

### 补写锐评

```bash
openclaw worklog comment \
  --sender-id telegram:YOUR_USER_ID \
  --day 2026-03-06 \
  --comment "这天主要是在收拾遗留问题。"
```

### 读取授权

```bash
openclaw worklog check-read --sender-id telegram:VIEWER_ID
openclaw worklog auth-read --sender-id telegram:VIEWER_ID --password 'YOUR_PASSWORD'
```

### 定位月文件

```bash
openclaw worklog locate \
  --sender-id telegram:YOUR_USER_ID \
  --month 2026-03 \
  --require-read-access
```

### 生成预览链接

```bash
openclaw worklog preview-url \
  --sender-id telegram:YOUR_USER_ID \
  --month 2026-03
```

返回结果类似：

```json
{
  "url": "http://127.0.0.1:3210/worklog-preview?senderId=telegram%3AYOUR_USER_ID&month=2026-03"
}
```

打开后：

- 管理员直接看到预览页
- 非管理员先输入浏览口令，再进入页面

## 配置说明

### `dataRoot`

插件数据根目录。建议与其他业务数据分离，便于迁移、备份和清理。

### `books`

静态声明的日志本集合。每个 key 代表一册账本。

### `senderRouting`

控制 sender 到日志本的映射逻辑：

- `mode`：是否按 sender 自动路由。
- `autoCreate`：未绑定时是否自动建本。
- `allowAutoBindSenders`：允许自动建本的 sender 白名单。
- `bindings`：已知 sender 到日志本 key 的绑定表。
- `nameTemplate` / `bookPathTemplate`：自动建本时使用的模板。

模板变量：

- `{dataRoot}`
- `{sender_id}`
- `{key}`

### `readAccess`

控制非管理员读取：

- `requirePasswordForNonAdminRead`
- `viewerPasswordEnv`
- `viewerPasswordEnvFile`
- `sessionTtlMinutes`
- `adminSenderIds`

### `writeGuard`

控制写入安全：

- `adminSenderIds`
- `restrictedPathPrefix`
- `denyFileUpload`
- `review.maxItemLength`
- `review.forbiddenPatterns`
- `review.forbiddenMessage`

### `commentPolicy`

控制锐评策略：

- `enabled`
- `title`
- `allowSameDayComment`
- `maxLength`

### `preview`

控制在线预览服务：

- `enabled`
- `host`
- `port`
- `basePath`
- `title`
- `sessionCookieName`

## 与旧实现的迁移关系

如果你已经有一批月度 Markdown 文件，这个插件可以直接接着写，不需要迁移文件格式。

迁移时主要做四件事：

- 把原有日志目录映射到 `books`
- 把原有 sender 绑定关系映射到 `senderRouting.bindings`
- 把原有管理员、口令和写入审查规则映射到 `readAccess` 与 `writeGuard`
- 如果你想让插件完全接管旧系统，再把原预览入口迁到 `preview` 服务

## 自检

编译：

```bash
npm install
npm run build
```

运行插件自检：

```bash
openclaw worklog self-test
```

该命令会在临时目录构造一套最小数据，验证：

- 自动建本
- 追加工时
- 月度汇总重算
- 锐评写入
- 非管理员读取范围限制
- 预览链接生成

## 设计取舍

- 这是面向工作日志场景的标准插件，不强绑某一个聊天平台
- 平台层只需要把解析后的 senderId、工作项、工时传给 CLI 即可
- 在线预览服务也复用同一套 sender、账本和读权限逻辑，不再另起一套影子规则

## 脱敏说明

仓库内所有示例都使用占位符：

- 不包含真实账号 ID
- 不包含真实目录路径
- 不包含任何密钥或口令
- 不包含宿主机器上的私有配置

这插件就是拿来搬家和复用的，不是给你把旧环境黑历史一锅端进去的。

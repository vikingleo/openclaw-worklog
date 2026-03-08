# Worklog 操作手册

这份文档不是开发设计稿，而是面向日常使用与运维的最终操作手册。

适用对象：

- 你自己日常记工作日志
- 通过 Telegram / 其他渠道操作 `worklog` 的 agent
- 管理员维护日志本、sender 绑定、Web 预览

## 1. 入口说明

### 普通入口

- `/worklog`
- `/worklog help`
- 中文别名：`/工作日志`

### 当前 Telegram 交互特点

- Telegram 下优先复用同一张卡片
- 保留文本命令模式，不强制只能点按钮
- `/worklog` 主菜单里可进入：
  - 记录日志
  - 今日记录
  - 本月统计
  - 最近 7 天
  - 日志本面板
  - Web 地址

### 非 Telegram 渠道

- 继续走纯文本命令模式
- 不依赖按钮也能完成主要操作

## 2. 普通用户命令

### 写入日志

- `/worklog 1.5 修复筛选回显`
- `/worklog append 2 联调 Telegram 卡片`

### 自然语言写入（先确认后落盘）

- `/worklog 今天联调 Telegram 卡片 2 小时`
- `/worklog 昨天修复 sender 绑定 1.5 小时`
- `/worklog 工作项：联调 Telegram 卡片，工时：2`

说明：

- 自然语言会先生成一张“待确认工作日志”卡片
- 点“写入”才真正落盘
- 点“修改”后，重新发一条新的 `/worklog ...` 即可覆盖旧草稿

### 选择工时后再补工作项

- `/worklog ah`
- `/worklog item 修复筛选回显`

### 查询

- `/worklog today`
- `/worklog month`
- `/worklog recent`
- `/worklog web`

### 编辑 / 删除单条记录

- `/worklog edit 2026-03-08 1`
- `/worklog replace 1.5 新内容`
- `/worklog delete 2026-03-08 1`

说明：

- Telegram 的“今日记录”卡里，前 5 条会显示 `✏️ / 🗑` 快捷按钮
- 删除是两步确认，不会直接一键删掉

## 3. 管理员命令

### 日志本管理

- `/worklog books`
- `/worklog create <key> <名称>`
- `/worklog rename <key> <新名称>`

示例：

- `/worklog create demo 演示日志本`
- `/worklog rename demo 演示日志本-新名字`

### 全局当前日志本切换

仅在 `senderRouting.mode = current` 时可用：

- `/worklog use <book>`

如果当前配置是 `by_sender_id`：

- 不允许直接切“全局当前日志本”
- 应改用 sender 绑定管理

### sender 绑定管理

- `/worklog bb`
- `/worklog bind <sender> <book>`
- `/worklog unbind <sender>`
- `/worklog bindings [页码] [关键字]`

示例：

- `/worklog bind telegram:6684352915 u-telegram-6684352915`
- `/worklog unbind telegram:6684352915`
- `/worklog bindings 1 6684352915`

说明：

- 这批命令管理的是运行时绑定
- 写入位置是插件状态文件里的 `senderBindings`
- 不会直接改宿主主配置里的静态 `senderRouting.bindings`

## 4. Web 预览

### 直接取地址

- `/worklog web`

### 地址结构

类似：

- `http://<host>:3210/worklog-preview?senderId=telegram%3A6684352915&month=2026-03&book=u-telegram-6684352915`

### 当前行为

- 已支持返回“可访问地址”，不再回 `0.0.0.0`
- 若配置了反向代理，优先按你的代理入口使用
- 非管理员读取仍受口令保护

## 5. 日志本归档 / 删除

### 归档

- `/worklog ba <book>`：进入归档确认
- `/worklog baa <book>`：确认归档

归档行为：

- 将目录改名保留
- 从活动日志本列表中移除
- 同时移除运行时绑定与运行时书本状态

### 删除空日志本

- `/worklog bd <book>`：进入删除确认
- `/worklog bdd <book>`：确认删除

删除约束：

- 只允许删除“运行时创建的日志本”
- 只允许删除“空目录”
- 非空目录必须先归档，不能直接删

## 6. 安全边界

### 默认允许 agent 直接做的事

- 当前对话内操作
- 无损查询
- 日志追加
- 单条编辑
- 单条删除确认后执行
- 运行时 sender 绑定调整
- 运行时日志本创建 / 重命名

### 不应默认静默做的事

- 改宿主主配置
- 删除非空日志本目录
- 删除静态配置里的日志本
- 对外网络动作的额外配置变更
- 超出 `restrictedPathPrefix` 的目录写入

### 为什么这样分层

因为 `worklog` 现在既承担：

- sender 路由
- 权限校验
- 文件落盘
- 预览
- Telegram 卡片交互

所以高风险动作必须保持确认流，不能让 agent 默认“顺手就改”。

## 7. 常见故障排查

### 1. `sender-not-allowed-for-auto-bind`

现在用户侧看到的提示会更直白：

- 当前发送者还没被允许自动绑定日志本
- 需要把该 sender 加进 `allowAutoBindSenders`
- 或由管理员先执行一次 `/worklog bind <sender> <book>`

原始含义：

- 当前 sender 没命中自动绑定白名单
- 或 sender 格式不一致（如 `6684352915` 与 `telegram:6684352915`）

优先检查：

- `senderRouting.allowAutoBindSenders`
- `senderRouting.bindings`
- 运行时 `senderBindings`
- 调用方是否传错 senderId

### 2. Telegram 没按钮 / 只剩文本

优先检查：

- 插件是否编译成功
- 网关是否已重启
- 旧卡片状态是否损坏
- Telegram `inlineButtons` 能力是否开启

### 3. `/worklog today` 显示今天没记录

通常不是“整本没日志”，而是：

- 当月文件存在
- 但当天 `YYYY-MM-DD` 分节还没写入

### 4. Web 地址打不开

优先检查：

- `preview.host / preview.port / preview.basePath`
- 网关进程是否监听该端口
- 本机防火墙 / 反向代理
- 浏览器访问时是否已完成读权限授权

## 8. 推荐日常操作流

### 你自己日常用

1. `/worklog`
2. 点“记录日志”或直接 `/worklog 1.5 xxx`
3. `/worklog today` 检查当日结果
4. `/worklog month` 看月统计

### 管理员维护用

1. `/worklog books`
2. 必要时：
   - `create`
   - `rename`
   - `bind`
   - `unbind`
3. 如需清理临时运行时日志本：
   - 先 `ba`
   - 再按需处理目录

## 9. 当前已上线能力清单

截至当前版本，已完成：

- Telegram 单卡片主菜单
- 记录日志输入态
- 今日记录 / 本月统计 / 最近 7 天
- `/worklog help`
- Web 预览地址回传
- 单条编辑 / 删除
- 日志本创建 / 重命名 / 切换页增强
- sender 绑定 / 解绑管理
- 绑定列表分页 / 搜索
- 运行时日志本归档 / 安全删除

## 10. 结论

现在这套 `worklog` 已经不是“只能记一条工时”的小插件，而是一套可用于：

- 个人工作日志记录
- 多 sender 分账本
- Telegram 卡片式管理
- 管理员运行时运维
- Web 预览访问

如果后续还要继续演进，优先建议做的是：

- 管理面板文案与确认流再压一轮
- 绑定列表的更强筛选
- 宿主配置与运行时状态的统一可视化

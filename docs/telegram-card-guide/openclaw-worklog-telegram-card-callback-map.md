# OpenClaw Worklog Telegram Callback Map

## 1. 设计原则

这份映射表只服务于一期 MVP。

一期原则：

- callback 必须短
- callback 尽量固定枚举
- 不默认在 callback 里放长 ID
- 按钮层只表达页面跳转和动作意图

建议统一前缀：

- `wg:` = worklog telegram callback

这样比 `worklog:` 更短，给 Telegram `callback_data` 留更多空间。

## 2. 一期固定 callback

| 页面/动作 | callback_data | 说明 |
|---|---|---|
| 主菜单 | `wg:m` | 打开主菜单 |
| 记录日志入口 | `wg:a` | 打开“记录日志”页面 |
| 今日记录 | `wg:t` | 打开今日记录卡片 |
| 本月统计 | `wg:s` | 打开本月统计卡片 |
| 帮助 | `wg:h` | 打开帮助卡片 |
| 直接输入内容 | `wg:ai` | 进入 `awaiting_worklog_input` |
| 只填工时 | `wg:ah` | 进入 `awaiting_hours_only` |
| 取消当前输入 | `wg:x` | 清空状态并返回主菜单 |
| 再记一条 | `wg:ta` | 从今日记录跳回记录入口 |
| 统计页返回 | `wg:sm` | 从统计页回主菜单 |
| 今日页返回 | `wg:tm` | 从今日页回主菜单 |
| 帮助页返回 | `wg:hm` | 从帮助页回主菜单 |

说明：

- 一期其实完全可以只保留 `wg:m / wg:a / wg:t / wg:s / wg:h / wg:ai / wg:ah / wg:x`
- `wg:ta / wg:sm / wg:tm / wg:hm` 主要是为了让页面动作更直白，可选

## 3. 页面建议

### 主菜单

标题：`工作日志`

按钮：

- `➕ 记录日志` → `wg:a`
- `📋 今日记录` → `wg:t`
- `📊 本月统计` → `wg:s`
- `⚙️ 帮助` → `wg:h`

### 记录日志页

标题：`记录工作日志`

按钮：

- `📝 直接输入内容` → `wg:ai`
- `⏱ 只填工时` → `wg:ah`
- `❌ 取消` → `wg:x`

### 今日记录页

按钮：

- `➕ 再记一条` → `wg:ta`
- `⬅️ 返回` → `wg:m`

### 本月统计页

按钮：

- `⬅️ 返回` → `wg:m`

### 帮助页

按钮：

- `➕ 去记录` → `wg:a`
- `📋 查看今日` → `wg:t`
- `⬅️ 返回` → `wg:m`

## 4. 一期不要放进 callback 的内容

以下内容暂时不要进入一期 callback 协议：

- `worklog:rename`
- `worklog:create`
- `worklog:switch`
- `worklog:edit:{id}:content`
- `worklog:edit:{id}:hours`
- `worklog:delete:{id}`

原因：

- 这些都暗示二期以后才会有的 service / 状态 / 权限复杂度
- 现在先写进协议，会让开发和文档一起虚胖

## 5. 若未来需要动态 callback

如果二期以后真的要做“编辑某条记录”，建议不要直接传长 ID，改成这种形式：

- `wg:e:{shortId}`
- `wg:ec:{shortId}`
- `wg:eh:{shortId}`
- `wg:del:{shortId}`

要求：

- `shortId` 必须由服务端生成
- `shortId` 生命周期要短
- 不能把完整 Markdown 行内容塞进 callback

## 6. 未知 / 过期 callback 兜底

统一处理：

- 回复：`这个按钮已经过期了，请重新打开工作日志。`
- 提供返回主菜单动作：`wg:m`

## 7. 与文本命令的关系

一期映射口径应写成：

| 文本入口 | 卡片入口 | 说明 |
|---|---|---|
| `工作日志` | `wg:m` | 建议新增或统一入口 |
| `/worklog` | `wg:m` | 可选新增别名，不是现有既有命令前提 |
| `记工作日志：...` | `wg:ai` | 最终都落到写入能力 |
| `工作日志列表` | `wg:t` | 一期先近似映射到“今日记录摘要”，不要说成完整等价 |

注意：

- `工作日志列表` 不一定等于“今日记录卡片”
- 文档里必须承认：这只是一期的近似入口，不是完全语义对齐

## 8. 最终建议

一期 callback 协议越短越好，越固定越好。

别一开始就把二期、三期按钮全预埋进去，不然实现的时候八成先乱的是你自己。

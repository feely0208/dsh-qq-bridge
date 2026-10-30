# @deepwhale-cn/dsh-qq-bridge

把 QQ 接进 DeepSeek Harness：一条通道发消息、收入站、留审计。
**v0.3 起两条通道二选一 + 官方机器人可开「自动回复」**：

- **QQ 官方机器人**（QQ 开放平台 WebSocket）：只填 AppID + AppSecret，不需要本机跑任何框架
- **OneBot v11**（本机 NapCat / Lagrange.OneBot 等框架）：v0.1 起支持，老配置照旧可用
- **自动回复**（v0.3，默认关闭）：关键词规则 + 模板，秒回；带防刷与失败自动暂停

**关键词**：QQ · QQ 官方机器人 · QQ 开放平台 · WebSocket · OneBot v11 · 自动回复 · 关键词规则 · IM 桥接 · 客服接待归档 · 企业审批通知 · 审计 · DeepSeek Harness 插件

## 为什么要有它

Agent 已经很会写东西，但「把结果送到人手上」经常还靠人复制粘贴。QQ 是很多团队实际在用的入口，
可它没有一个受控、可审计、能被 Agent 调用的通道。这个插件补的就是这一段：

- **发得出去**：面板或 `qq_send` 工具直接把消息发到群/私聊/频道
- **收得进来**：官方机器人 dispatch 事件、OneBot 上报都落到本机同一个队列（上限 1000 条）
- **留得下痕**：谁在什么时候发了什么、成功还是失败、为什么失败（含官方 code / trace_id），全部写审计 JSONL
- **不越界**：AppSecret / access_token 只存本机、请求 10s 超时、只连官方域名与你填的端点、不向第三方外发数据

三个典型用法：法律/客服接待归档、企业审批通知、多渠道统一后台的基础通道。

## 安装

```bash
dsh plugin --profile web add @deepwhale-cn/dsh-qq-bridge
```

装完重启桌面端/DSH，侧栏会出现「QQ 桥接」。

---

## 3 分钟上手（零基础，照着点就行）

**你需要**：一台 Mac 或 Windows 电脑（常开最好）+ 一个 QQ 号（建议小号）+ 一个 QQ 机器人（免费注册，下面第 2 步）。

1. **装插件**（在电脑的终端里跑）：`dsh plugin --profile web add @deepwhale-cn/dsh-qq-bridge`，然后重启桌面端。
2. **建机器人**：浏览器打开 <https://q.qq.com>，QQ 扫码登录 → 创建机器人 → 在「开发设置」里抄下 **AppID** 和 **AppSecret**（两串字符，别发给别人）。
3. **填进面板**：桌面端侧栏「QQ 桥接」→「QQ 官方机器人」页签 → 粘贴 AppID、AppSecret → 「保存配置」。
4. **连上**：点「连接」，状态显示 `已连接（你的机器人名）` 就是通了。
5. **拉进群 / 私聊**：把机器人拉进你的 QQ 群，或在手机 QQ 搜机器人名字私聊它。
6. **开自动回复（可选）**：面板「自动回复」卡片 → 打开开关 → 填默认模板和关键词规则 → 「保存并生效」。

完成。之后：群里 **@机器人** 或**私聊它**，就能收到回复；每条收发都能在面板「入站 / 审计」里看到。

> ⚠️ 两个平台规则必须知道：① 群里只有**真正 @ 机器人**的消息才收得到（手打「@名字」不算，要从成员列表点选）；② 机器人只能回**先跟它说过话的人**，直接给陌生人发消息需要官方「主动消息」权限。

---

## 在 iPhone / 安卓手机上怎么用

**手机只需要装 QQ，不用装这个插件，也不用做任何配置。**

- 手机 QQ 里私聊机器人 → 手机就是普通聊天窗口，机器人在你电脑上回复，手机收到
- 手机 QQ 群里 @ 机器人 → 同上
- **配置必须在电脑上做**（AppID/AppSecret、关键词、模板）；手机打开管理面板需要额外做内网/公网访问，默认没有
- **电脑关机或 DSH 没开 → 机器人不回**：机器人本体跑在你的电脑上，不是云端服务

---

## 报错对照表

| 面板里看到的 | 意思 | 怎么处理 |
|---|---|---|
| `40034105 主动消息无权限` | 你在给「没先说话的人」发消息 | 用入站消息旁的「回复」按钮（带 msg_id 被动回复），或去 q.qq.com 申请主动消息配额 |
| `40034005 回复消息 msg_id 已过期` | 被动回复窗口（约 5 分钟）过了 | 让对方重新发一条，再点「回复」 |
| `401 / token 错误` | AppSecret 填错或被重置 | 回 q.qq.com 重新复制 AppSecret，面板里「清除 AppSecret」后重填 |
| `连不上 OneBot 端点 / fetch failed` | 走的是 OneBot 通道，但本机没跑框架 | 换用「QQ 官方机器人」通道，或先启动 OneBot 框架 |
| `沙箱` 勾了但连不上 | 沙箱环境和正式环境的两套密钥/地址不同 | 只在你确实用沙箱机器人时勾选；不确定就取消勾选 |

---

## 通道一：QQ 官方机器人（v0.2 新增，推荐先用这条）

不需要本机 OneBot 框架，直接走 QQ 开放平台的官方 WebSocket。

### 1. 在 q.qq.com 拿 AppID / AppSecret

1. 打开 <https://q.qq.com/>，用 QQ 扫码登录「QQ 开放平台」。
2. 「应用管理」→ 创建机器人应用（个人开发者或企业主体，按平台要求提交资料）。
3. 进入应用 →「开发设置」→ 记下 **AppID**，点「生成 / 重置」拿到 **AppSecret**（只显示一次，丢了只能重置）。
4. 「开发设置 → IP 白名单」按需配置；本插件从你的本机发起，不在白名单里的固定出口 IP 时官方会拒绝。

把这两项填进侧栏面板「QQ 官方机器人」区域的 AppID / AppSecret，点「保存配置」，再点「连接」。

> AppSecret 只写 `~/.dsh/qq-bridge.json`（`0600`）。面板、HTTP 接口、审计、日志里都只出现掩码（`••••后四位`）；
> 想换密钥就重新填一次（留空 = 不修改），想清掉就点「清除 AppSecret」。

### 2. 开启 WebSocket 接入

QQ 开放平台默认推荐 WebSocket（官方文档的「WebSocket 连接」/「事件订阅」）。要点：

- 面板里的「沙箱环境」勾选后走 `sandbox.api.sgroup.qq.com`，仅供调试；正式上线取消勾选走 `api.sgroup.qq.com`。
- 本插件订阅的是**群与私聊事件**（`intents = 1 << 25`），覆盖 `GROUP_AT_MESSAGE_CREATE`（群里 @ 机器人）与
  `C2C_MESSAGE_CREATE`（用户私聊机器人）。
- 频道事件（`AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE`）也会被归一化入队，但需要在开放平台给机器人授予频道权限。

### 3. 把机器人拉进群 / 让人私聊它

- **群**：QQ 群 →「群设置」→「群机器人」→ 添加你的机器人。**机器人必须已上线或在该应用的测试范围内**；
  沙箱调试时在开放平台「沙箱配置」里绑定调试群。
- **私聊（C2C）**：用户直接把机器人加好友并发消息。官方限制「用户主动发起」后机器人才能回。
- 群机器人默认**只能收到 @ 它的消息**，这是平台规则，不是插件漏消息。

### 4. 权限与主动消息（会被配额卡住的地方）

- **被动回复**：收到消息后带原消息 `msg_id` 回复，属于被动消息，基本不受主动推送配额限制。
  面板里点入站消息旁的「回复」、或工具里传 `msg_id`，走的就是这条路。
- **主动消息**：不带 `msg_id` 直接发给用户/群，受平台主动消息配额限制，且只能在允许的场景/时段发；
  被拒绝时错误码会原样回报（`code` / `message` / `trace_id`）并写审计，不会静默失败。
- 富媒体（图片/文件/语音）、撤回、按钮交互都**没做**；当前只发纯文本（≤4000 字符）。

### 链接与密钥流向

| 用途 | 地址 | 携带什么 |
|---|---|---|
| 取 access_token | `https://bots.qq.com/app/getAppAccessToken` | AppID + AppSecret（POST body） |
| 取网关 / 发消息 / 其他 API | `https://api.sgroup.qq.com`（沙箱 `https://sandbox.api.sgroup.qq.com`） | `Authorization: QQBot <access_token>` |
| WebSocket | gateway 返回的 `wss://` 地址（官方域） | identify 帧里带 `QQBot <access_token>` |

access_token 只在内存里缓存到 `expires_in - 60s`，401 会自动清缓存重取一次；不落盘、不进审计。
`op7` 重连复用缓存 token，`op9` 会话失效会换 token 再连，断线按 1s/2s/4s/8s/16s/30s 退避重连。

### 合规边界（用官方机器人先读这段）

- 必须遵守 [QQ 开放平台服务条款](https://q.qq.com/) 与平台审核要求；不得群发广告、骚扰、诱导分享。
- 官方机器人是**平台授权通道**，不做协议逆向、不模拟登录、不共享 AppSecret。
- 收到、发出的消息正文会落在本机 `~/.dsh/qq-bridge-inbox.json` 与 `~/.dsh/qq-bridge-audit.jsonl`（明文，`0600`），
  涉及个人信息时请按《个人信息保护法》自行评估留存必要性，别把这两个文件放进共享目录/云盘。
- 本插件不提供「绕过审核」「自动加群」「群发」能力；配额与权限由平台决定。

---

## 自动回复（关键词 + 模板 + 防刷）· v0.3

只作用于**官方机器人通道**（OneBot 通道仍只入队 + 审计）。默认关闭，面板里随时可开/可关。

### 它怎么工作

1. 收到 `C2C_MESSAGE_CREATE`（私聊）或 `GROUP_AT_MESSAGE_CREATE`（群里 @ 机器人）→ **先入队**（保证不丢）→ 立刻评估规则。
2. 「全部」范围下私聊 + 群 @ 都会回；默认「只回私聊」。
3. 规则按面板里的**行顺序**匹配，命中第一条就用它的回复；都不命中用默认模板。
4. 用原消息的 `msg_id` 做**被动回复**（不占主动消息配额），秒级发出，不等轮询。
5. 写审计：`动作=自动回复`、`来源=auto`、命中规则索引 / 关键词 / 匹配模式 / 结果 / 错误码。

### 规则写法（面板每行一条）

```
价格,多少钱=价格表发你了，{昵称}可以看下
精确:你好=你好呀
正则:^订单\d+$=这就帮你查订单
```

- 第一条：`包含`模式（默认），逗号分隔多个关键词，命中任意一个即可
- 第二条：`精确:` 前缀 = 完全相等
- 第三条：`正则:` 前缀 = 正则匹配（写错了这条自动跳过，不影响后面的规则）
- 占位符：`{昵称}`（没有就用「你」）、`{内容}`（对方原文，已清洗表情/图片标记）、`{时间}`（当前 HH:MM）
- 回复文本清空 = 这条不回复（跳过并计数，不会发空消息）

### 平台限制与失败原因（会被卡住的地方）

- **被动回复窗口 5 分钟**：带 `msg_id` 的回复在 5 分钟内有效；过期返回 `40034005 回复消息msg_id已过期`。
  插件在本地按事件时间判断，**超过 4.5 分钟就不再尝试**，不会白白打一次失败请求。
- **主动消息无权限**：不带 `msg_id` 直接发会返回 `40034105`，所以自动回复一律带原消息 `msg_id`；
  入站若没有 `msg_id`（理论上不会有）直接跳过，不发这种必然失败的请求。
- **空模板不硬发**：默认模板或命中规则的回复为空时跳过，并写一条 `结果=跳过` 的审计（属于配置写错，要能查出来）。
- 群消息只有**被 @** 才会推给机器人（平台规则），不是插件漏消息。
- 同一 `msg_id` 想回多条需要平台侧 `msg_seq`，当前每条入站只回一条。

### 防刷参数（面板可改）

| 参数 | 默认 | 作用 |
|---|---|---|
| 最小间隔 | 30s | 同一会话（c2c openid / group_openid）两次自动回复的最小间隔，避免连续刷屏 |
| 每小时上限 | 60 条 | 全局（所有会话合计）每小时自动回复上限；成功发送才计数 |
| 失败暂停 | 连续 3 次 | 连续 3 次发送失败自动暂停，面板显示最近失败原因；点「恢复自动回复」清零并继续 |
| 过期保护 | 4.5 分钟 | 超过窗口直接跳过，不发请求 |
| 并发锁 | 同会话 1 条在途 | 两条消息几乎同时到，第一条还在发时第二条让路（避免同一会话各回一条） |

面板还会显示「今日已自动回复 N 次 · 本小时 x/上限 · 连续失败 k」，跳过原因只做计数不逐条写审计。

### 合规边界

- 只做**关键词/模板回复**，不冒充人工、不伪造身份；回复内容由你自己负责。
- 默认关闭、随时可关；不要用来自动群发广告、骚扰或规避平台审核。
- 自动回复记录（含内容）会写本机审计 `~/.dsh/qq-bridge-audit.jsonl`（`0600`）。

---

## 通道二：OneBot v11（v0.1 起支持）

本插件不自带 QQ 协议实现，需要你本机已经有 **OneBot v11 的 HTTP API**，例如 NapCat、LLOneBot、Lagrange.OneBot。
把它们的 HTTP API 服务开在 `http://127.0.0.1:3000`（或你自己的地址/端口），并记住 access_token。

面板「通道切换」选 OneBot v11：

| 字段 | 说明 |
|---|---|
| 端点 | OneBot v11 HTTP API 地址，例如 `http://127.0.0.1:3000`。只允许 http(s)，不能带账号/查询串 |
| access_token | OneBot 的 access token，请求时放在 `Authorization: Bearer` 头里；留空 = 不修改 |
| 上报共享密钥 | 可选。配置后 `/api/hook` 校验 `X-Signature`（HMAC-SHA1）或 Bearer token |

### 让 OneBot 把上报推过来

在 OneBot 实现里把 HTTP 上报地址设为：

```
http://127.0.0.1:<DSH 的 Web 端口>/dsh-qq-bridge/api/hook
```

建议同时配一个共享密钥，并在插件面板填同一个值。上报端用
`X-Signature: sha1=<HMAC-SHA1(密钥, 原始请求体) hex>` 签名；插件也接受
`Authorization: Bearer <密钥>` 或 `?access_token=<密钥>`。若没有单独填「上报共享密钥」，
则退回用 access_token 校验；两者都为空时不校验（审计会注明）。

---

## 配置

两条通道的配置都在同一个文件 `~/.dsh/qq-bridge.json`，权限 `0600`：

| 字段 | 说明 |
|---|---|
| `mode` | `onebot`（默认，兼容 v0.1）或 `official`；没配按 onebot |
| `official_appid` | 官方机器人 AppID（明文，不是密钥） |
| `official_secret` | 官方机器人 AppSecret（只在本机文件里，接口只回掩码） |
| `official_sandbox` | 是否走沙箱环境 |
| `official_auto_connect` | 启动 DSH 时自动连接官方机器人（默认关） |
| `official_auto_reply` | 自动回复总开关（默认 `false`） |
| `official_reply_text` | 默认模板，支持 `{昵称}` `{内容}` `{时间}` |
| `official_reply_rules` | 关键词规则数组 `[{关键词:[...], 回复, 模式}]`，顺序命中第一条 |
| `official_reply_scope` | `c2c`（默认，只回私聊）或 `all`（私聊 + 群 @） |
| `official_reply_min_interval_ms` | 同一会话最小间隔，默认 `30000` |
| `official_reply_hourly_cap` | 全局每小时上限，默认 `60` |
| `endpoint` / `access_token` / `hook_secret` | OneBot v11 通道的原有字段 |
| `default_target_type` / `default_target` | 面板发送区的默认目标 |

**完整 AppSecret / access_token 不会出现在接口响应、面板、审计或日志里。**

## 面板

| 区域 | 内容 |
|---|---|
| 通道切换 | 「QQ 官方机器人」/「OneBot v11」，在对应区域点保存后生效 |
| 官方机器人 | AppID、AppSecret（掩码）、沙箱开关、自动连接开关；连接 / 断开 / 刷新状态；状态（已连接 / 握手中 / 重连中 / 错误原因）、机器人昵称与 ID、心跳间隔、重连次数 |
| 官方发送 | 私聊 c2c / 群 group / 频道 channel / 频道私信 dm + 目标 id + 可选 `msg_id`；正文 ≤4000；「回复最近一条」一键带入 |
| 自动回复 | 开关、默认模板、关键词规则（每行 `关键词1,关键词2=回复`，可加 `精确:`/`正则:`）、范围（只回私聊 / 私聊+群 @）、最小间隔（秒）、每小时上限；显示今日次数/本小时用量/连续失败/暂停原因；「保存并生效」「恢复自动回复」 |
| OneBot 配置 | 端点 / token / 上报密钥；「连接测试」调 `get_login_info` 并显示 QQ 昵称 |
| OneBot 发送 | 私聊或群聊 + 号码 + 正文 |
| 入站消息 | 两条通道同一个队列，最近 30 条；官方记录显示 群/私聊/频道、发送者 openid 后 6 位、事件类型、内容、时间，带「回复」按钮（自动带入 openid/group_openid + msg_id） |
| 审计 | 最近 30 条：连接、发送、收到的入站、被拒绝的参数（token / AppSecret 已脱敏） |

## Agent 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `qq_send` | `text`（必填）+ 官方：`mode=official`、`channel`（c2c/group/channel/dm）、`openid`、`group_openid`、`channel_id`、`guild_id`、`msg_id`；OneBot：`target`、`target_type`（private/group） | 发消息；与面板共用配置和审计 |
| `qq_inbox` | `limit`（默认 20，最多 1000） | 读最近入站（两条通道归一化字段），只读本机队列，不触发联网 |

`qq_send` 不填 `mode` 时用面板配置的通道；v0.1 的老参数（`target` + `target_type` + `text`）继续可用。

## HTTP 出口

前缀 `/dsh-qq-bridge`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 通道、端点、官方 AppID、各类密钥掩码 |
| POST | `/api/config` | 保存配置（`clear_token` / `clear_hook_secret` / `clear_official_secret` 可清除） |
| POST | `/api/test` | 调 OneBot `get_login_info` |
| POST | `/api/send` | 发消息（按 `mode` 分派；官方用 `channel` + openid 类字段） |
| GET | `/api/official/status` | 官方机器人连接状态（状态、机器人昵称/ID、心跳、重连次数、错误原因） |
| POST | `/api/official/connect` | 连接官方机器人（未配 AppID/AppSecret 时 400） |
| POST | `/api/official/disconnect` | 断开官方机器人 |
| GET | `/api/official/autoreply` | 自动回复配置 + 今日/本小时统计 + 暂停原因 |
| POST | `/api/official/autoreply` | 保存自动回复配置；`{恢复:true}` 手动解除暂停 |
| GET | `/api/inbox?limit=N` | 最近入站（两条通道同一队列） |
| GET | `/api/audit?limit=N` | 最近审计 |
| GET | `/api/badge` | powered-by-dwh 徽章 |
| POST | `/api/hook` | OneBot v11 事件上报入口（返回 204） |

## 安全边界（重要）

- **密钥只存本地**：`~/.dsh/qq-bridge.json`，`0600`；接口只回掩码；审计递归脱敏（`official_secret` / `clientSecret` / `appSecret` 键，`Bearer xxx` 与 `QQBot xxx` 串）。
- **access_token 只在内存**：缓存到 `expires_in - 60s`，只发给 `bots.qq.com` / `api.sgroup.qq.com`（沙箱为 `sandbox` 同名域）。
- **只允许 http(s) OneBot 端点**，拒绝 URL 内嵌账号/口令/查询串；官方域固定，不可配置成任意域名。
- **请求 10s 超时**，失败如实回报（HTTP 状态 / 官方 code、message、trace_id / 超时），不静默吞错。
- **上报鉴权**（OneBot）：配置了共享密钥就强制校验；未配置时放行但审计注明「未配置共享密钥」。
- **自动回复默认关**：开了只按你的关键词/模板被动回复，不冒充人工；连续失败自动暂停，随时可关。
- **先入队再回复**：自动回复失败不影响入站记录；发送失败原因（含官方 code/trace_id）全部写审计。
- **数据留在本机**：入站队列 `~/.dsh/qq-bridge-inbox.json`（上限 1000 条）、审计 `~/.dsh/qq-bridge-audit.jsonl`。
  两者都是明文，含消息正文，注意不要放在共享目录。
- **不联网外发**：除了（按通道）官方域名或你填的 OneBot 端点，本插件不访问任何第三方服务，无遥测。

## v0.3 已知边界

- 自动回复只在官方机器人通道；只按关键词/正则/模板回，不做多轮会话、上下文理解、人工接管路由
- 自动回复状态（今日次数/暂停/会话间隔）在进程内存里，重启 DSH 后计数与暂停状态清零（配置本身持久化）
- 自动回复是「一问一答」的关键词/正则匹配，不理解上下文；同一 `msg_id` 不会重复回（并发锁 + 会话间隔）
- 同一 `msg_id` 多条回复需平台 `msg_seq`，当前每条入站只回一条；富媒体/撤回/按钮没做
- 官方通道只发纯文本（≤4000 字符）；主动消息受平台配额限制，被动回复需带 `msg_id`
- 群机器人只收 @ 它的消息（平台规则）；频道事件需额外权限，且不参与自动回复
- 不做多账号管理；一个 profile 一套配置（官方与 OneBot 各一套，二选一）
- 入站只存最近 1000 条，不做全文检索/导出；队列与审计为明文，未做加密与轮转

## 开发与自测

```bash
node --check lib/core.js
node --check lib/official.js
npm run preflight   # 客户端 bundle 预检（必须通过）
npm test            # 全程离线：假 OneBot + mock fetch/WebSocket，不连外网
```

测试覆盖：配置与掩码（含 AppSecret 留空/清除/AppID 校验）、OneBot 发送与失败回报、官方 token 缓存/强制刷新/失败报错、
hello→identify→READY、op11 ack、op7 重连、op9 换 token、断线退避、四类官方事件归一化入队、发送 payload（含 `msg_id`）、
401 自动重取、审计脱敏（含 `QQBot` token）、HTTP 出口（status/connect/disconnect/send/autoreply）、客户端面板三种状态渲染、
自动回复（规则顺序与三种模式、占位符、默认模板、空模板跳过、scope 过滤、会话间隔、每小时上限、4.5 分钟过期保护、
连续失败暂停与恢复、审计来源 auto、连接器秒回联动、端到端装配）。

## License

MIT。本插件是一个工具；使用者必须遵守所在地区法律法规与 QQ/QQ 开放平台/OneBot 服务条款，
**对使用本项目造成的任何后果自行承担责任**。

---

[![](https://img.shields.io/badge/powered_by-dwh-005A8C?style=flat&logoColor=white)](https://deepwhale.org.cn)

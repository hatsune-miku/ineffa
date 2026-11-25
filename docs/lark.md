# 飞书 / Lark

1. 在开放平台创建企业自建应用，开启机器人能力。
2. 在事件与回调中选择长连接，订阅 `im.message.receive_v1`。无需公网回调地址。
3. 开通下表中的应用权限，发布应用，并将机器人加入目标群聊。
4. 在 Ineffa 的平台账号中选择飞书 / Lark，填写 App ID、App Secret、允许访问的群聊和用户 ID。

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收私聊 |
| `im:message.group_msg.include_bot:read` | 接收群内用户和其他机器人的消息 |
| `im:message:send_as_bot` | 发送消息 |
| `im:message:update` | 更新回复卡片 |
| `im:resource` | 上传、下载图片和文件 |
| `im:message:readonly`、`im:message.group_msg` | 读取会话历史 |

群聊 ID 使用 `oc_` 开头的 Chat ID，用户 ID 使用当前应用下 `ou_` 开头的 Open ID。空访问列表不允许访问任何会话。不同应用的用户 Open ID 不能直接互换。

群内未提及机器人的消息会进入上下文，只有提及才触发回复。只申请群内 @ 权限无法获得完整背景消息。正文、tokens、工具状态和 debug 共用一张卡片；更新沿用 Ineffa 的 500 ms 防抖。`/new`、`/abort`、`/debug` 和指定用户下一条文本回答 question 的规则与其他平台一致。

图片和文件先通过平台上传，再发送原生附件消息。附件说明作为对附件的卡片回复；每次发送一个附件，图片上限 10 MiB，其他文件上限 20 MiB。普通回复使用 Markdown 卡片；超过单卡片容量时，生成期间展示前缀，完成后上传完整 `reply.md`，原卡片保留原生 @ 和调试备注。卡片内部附件及合并转发子消息的资源下载不受飞书消息资源接口支持。

当前支持企业自建应用；未接入商店应用安装流程、跨租户授权和卡片按钮表单。飞书与国际 Lark 分别连接各自服务。

参考：[官方 SDK](https://github.com/larksuite/node-sdk)、[消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[权限列表](https://open.larkoffice.com/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list)。

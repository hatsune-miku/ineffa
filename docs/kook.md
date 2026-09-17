# KOOK 接入

## 心跳与重连

对 `@kookapp/js-sdk@0.1.3` 的静态检查确认：`dist/ws/ws-client.js` 的 `isKMessage` 强制所有信令包含 `d`，而官方 PONG 示例是 `{"s":3}`。这样的合法响应会被丢弃，心跳重试也无法恢复；若随后的 resume 未得到确认，就会出现 `In-socket resume timed out`。

Ineffa 为每个账号创建一个客户端，只调用 `connect()` / `disconnect()`，监听器只注册一次，没有自己发送心跳或推进 SDK 状态机。当前证据指向 SDK 的协议校验缺陷，不能据此断言线上每一次超时都来自同一原因。

修复以 `patches/@kookapp%2Fjs-sdk@0.1.3.patch` 随仓库保存，Bun 安装依赖时自动应用；只允许 PONG 缺省 `d`，保留其他信令校验。Adapter 的“已连接”状态也改为等待协议握手完成，而不是仅凭 WebSocket 打开。

本地模拟网关覆盖了压缩与非压缩 PONG、连续心跳和服务端 RECONNECT。尚未验证真实弱网、长时间断网恢复和 KOOK 服务端的全部行为。SDK 的完整 resume 状态机仍是上游责任：例如当前实现先在原 socket 发 resume，回退时通过 gateway API 传递恢复参数，与文档描述的重新连接旧 URL 不完全一致；这次没有重写该状态机，也没有宣称整个 SDK 已通过稳定性认证。

参考：[WebSocket 协议](https://developer.kookapp.cn/doc/websocket)。

## 图片与文件

- 接收图片和旧附件事件的 `extra.attachments`，也解析现代卡片中的图片、文件、音视频模块。普通链接和按钮不视为附件。
- 未 @ 的群聊附件随背景消息保存，下一次触发回复时一起提交。文件先下载到账号工作目录的 `.ineffa-attachments/`；OpenCode 2.0.3 的附件输入只接受本地文件或 data URI，不能直接传 HTTP URL。
- 远端附件只接受 KOOK 媒体域名的 HTTPS URL，不跟随重定向，下载超时 30 秒，单文件最大 20 MiB。单条消息最多 10 个附件。模型能否直接理解图片、PDF 等仍取决于模型能力；其他文件可使用工作目录中的文件路径处理。
- 模型通过 `send_file({ path, caption? })` 将当前工作目录内的文件发到当前会话，沿用 OpenCode 的 `send_file` 权限配置。发送前在数据目录保存内容快照，重试不会读取被修改后的源文件。
- 发送先调用 `asset/create` 上传，再以 `type:10` 卡片的 `image` 元素或 `file` 模块发送。KOOK 明确说明：新上传资源默认不可见，单纯把 URL 写成 KMarkdown 链接不能使其可见。PNG、JPEG、GIF 以内嵌图片发送，其他格式作为文件。
- 频道与私聊采用相同上传流程。流式回复从第一次发送起就是卡片，编辑仍遵守 500ms 间隔；超长正文最终转成 `reply.md` 文件模块，避免尝试把已发出的 KMarkdown 消息改成另一种消息类型。
- 文件投递使用现有确认、去重和结果未知机制；上传失败不会发送一个空链接。发送结果未知时不自动重发。WebUI 中也可下载已发送的文件快照。

工作目录中的接收附件和数据目录中的发送快照随现有目录备份，目前不自动清理。

参考：[消息事件](https://developer.kookapp.cn/doc/event/message)、[上传媒体](https://developer.kookapp.cn/doc/http/asset)、[卡片](https://developer.kookapp.cn/doc/cardmessage)、[频道发送](https://developer.kookapp.cn/doc/http/message)、[私聊发送](https://developer.kookapp.cn/doc/http/direct-message)。

## question 与其他交互

`question` 使用 OpenCode 原生表单。被问用户固定为本轮任务最初的真人发起者；经过 Agent 间转交也沿用原始用户。每题发送一条带该用户 mention 的通知，并显示选项。

只有该用户在原频道或同一 Bot 的已授权私聊中的下一条文本会作为答案，无需 @。可回复序号、选项名称或自由文本；多选用逗号分隔。多题逐题提问。存在多个待回答问题时，需在原频道引用具体问题，避免私聊答案被任意分配。其他成员、其他频道、Bot 消息及附件不会填入问题；slash command 仍走控制命令路径。

答案直接调用原生 `form.reply`，不会再作为新 prompt 触发第二轮生成。问题通知、状态信息、命令仍不进入模型上下文；答案通过原生工具结果进入上下文。WebUI 回答、取消、`/abort`、归档和 `/new` 会关闭对应的捕获；重复平台消息不会回答下一题。

OpenCode 2.0.3 的表单只在内存中存在。连接中断但进程仍存活时可以重新发现待答表单；进程重启后旧问题失效，Ineffa 会提示用户，并保留旧答案的去重记录。Ineffa 不重建已经消失的工具等待、不自行重跑任务。权限请求和非 question 表单会在平台提示，到 WebUI 完成授权或填写。

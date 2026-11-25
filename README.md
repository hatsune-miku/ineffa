# Ineffa

多平台 Agent 运行平台，提供 CakeUI Web 界面，支持 KOOK、飞书和 Lark。OpenCode 与 Pi 在同一进程内运行，各自管理会话、模型与工具执行。

## 启动

需要 Bun 1.3.9 或兼容版本；浏览器功能需要 Node.js 20+。

```sh
bun install --frozen-lockfile
bun run browser:install
bun run build
bun start
```

打开 [http://127.0.0.1:4097](http://127.0.0.1:4097)，在「连接与运行」中配置模型、平台账号、MCP 和 Agent，查看 Skills 与运行设置。[WebUI 功能](docs/webui.md)

- 支持自定义 OpenAI 兼容服务、Volcengine Agent Plan，以及为每个账号绑定模型。
- KOOK 账号可按服务器、频道和私聊用户设置访问范围。群聊未 @ 的消息作为背景，@ 后触发回复。
- 飞书 / Lark 使用自建应用长连接，支持群聊、私聊、卡片和附件。[接入说明](docs/lark.md)
- 支持图片与文件收发，question 可由指定用户免 @ 回答。[KOOK 接入说明](docs/kook.md)
- 内置无头 Chromium，无需 OpenCode 桌面端。[浏览器安装与隔离](docs/browser.md)
- 每个账号可选择后端，新会话生效，已有会话保留原后端。Pi 首版使用已配置的 OpenAI 兼容模型。[后端能力](docs/backends.md)
- 账号身份与职责可自定义，支持 `{displayName}`、`{platformId}` 宏。

| 命令 | 用途 |
| --- | --- |
| `/new` | 归档当前会话，开启新会话 |
| `/abort` | 停止当前输出并清空排队输入 |
| `/debug on\|off` | 开关耗时与缓存命中统计 |
| `/help` | 查看命令 |

## 配置与开发

日常配置在 WebUI 完成。高级配置参考 [ineffa.config.example.ts](ineffa.config.example.ts)，环境变量参考 [.env.example](.env.example)。MCP、Skills、Agent 与运行设置页目前对应 OpenCode；权限默认静默允许。

「连接与运行 → 配置迁移」可导出明文 JSON，包含保存的模型配置、凭据和平台账号；导入时逐项选择合并方式及账号工作目录，重启服务后生效。环境变量、代码配置、Skills 文件和会话历史需另行迁移。

本地数据保存在 `.ineffa/`，工作文件保存在 `workspace/`；备份前先停止服务，再一起复制这两个目录。

```sh
bun run dev       # 后端，保存后重启
bun run dev:web   # Vite 前端，http://127.0.0.1:5173，热更新
bun run check     # 类型检查、测试与构建
```

架构与设计取舍见 [ARCH.md](ARCH.md)。

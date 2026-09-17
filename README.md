# Ineffa

基于 OpenCode 的多平台 Agent 运行平台，提供 CakeUI Web 界面，官方支持 KOOK。OpenCode 在同一进程内运行，负责会话、模型与工具执行。

## 启动

需要 Bun 1.3.9 或兼容版本。

```sh
bun install --frozen-lockfile
bun run build
bun start
```

打开 [http://127.0.0.1:4097](http://127.0.0.1:4097)，在「连接与运行」中配置模型和平台账号。

- 支持自定义 OpenAI 兼容服务、Volcengine Agent Plan，以及为每个账号绑定模型。
- KOOK 账号可按服务器、频道和私聊用户设置访问范围。群聊未 @ 的消息作为背景，@ 后触发回复。
- 每个频道与账号组合对应独立的 OpenCode 会话，Agent 可通过 mention 协作。
- 账号身份与职责可自定义，支持 `{displayName}`、`{platformId}` 宏。

| 命令 | 用途 |
| --- | --- |
| `/new` | 归档当前会话，开启新会话 |
| `/abort` | 停止当前输出并清空排队输入 |
| `/debug on\|off` | 开关耗时与缓存命中统计 |
| `/help` | 查看命令 |

## Docker

从源码启动：复制 `.env.example` 为 `.env`，设置随机 `INEFFA_TOKEN`，然后运行：

```sh
docker compose up --build -d
```

使用私有镜像时，以 [deploy/compose.yaml](deploy/compose.yaml) 作为部署目录的 `compose.yaml`，在 `.env` 中设置：

```dotenv
INEFFA_IMAGE=l2a1knla/ineffa:latest
INEFFA_TOKEN=替换为自己的随机令牌
```

启动或更新：

```sh
docker login
docker pull l2a1knla/ineffa:latest
docker compose up -d
```

也可将 `latest` 换为固定版本标签，同时修改 `.env` 和拉取命令。

默认仅监听本机 `4097` 端口，容器内工作目录为 `/app/workspace`。远程访问可使用 `ssh -L 4097:127.0.0.1:4097 用户@服务器`。

更新时保留原部署目录、`.env` 和数据卷，**不要执行 `docker compose down -v`**。备份前先停止服务，再备份数据与工作目录两个卷。

需要离线镜像包时运行 `bun run docker:pack`，按生成的 `release/` 目录内说明部署。

## 配置与开发

日常配置在 WebUI 完成。高级配置参考 [ineffa.config.example.ts](ineffa.config.example.ts)，环境变量参考 [.env.example](.env.example)。Skills、MCP 和工具权限沿用 OpenCode 配置。

「连接与运行 → 配置迁移」可导出明文 JSON，包含保存的模型配置、凭据和平台账号；导入时逐项选择合并方式及账号工作目录，重启服务后生效。环境变量、代码配置、Skills 文件和会话历史需另行迁移。

本地数据保存在 `.ineffa/`，工作文件保存在 `workspace/`；备份前先停止服务，再一起复制这两个目录。

```sh
bun run dev       # 后端，保存后重启
bun run dev:web   # Vite 前端，http://127.0.0.1:5173，热更新
bun run check     # 类型检查、测试与构建
```

架构与设计取舍见 [ARCH.md](ARCH.md)。

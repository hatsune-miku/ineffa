# Ineffa

Ineffa 是基于 OpenCode 的多平台 Agent 运行平台，使用一个 Bun 进程并附带 CakeUI Web 界面。消息平台通过 Adapter 接入，KOOK 由官方 `ineffa-kook` 支持。路由只匹配身份、地址和明确的 mention，没有内置长期记忆、模型路由器或工作流编排器。

Ineffa 是运行平台的名称。平台上的 Bot / Agent 使用各自配置的名称、身份和职责，不默认自称 Ineffa。

## 运行

需要 **Bun 1.3.9 或兼容版本**。依赖锁定于 `bun.lock`，OpenCode SDK 固定为 **2.0.3**。

```sh
bun install --frozen-lockfile
bun run build
bun start
```

打开 [http://127.0.0.1:4097](http://127.0.0.1:4097)。在「连接与运行」中连接模型提供方，然后创建会话并选择模型。已有 OpenCode 配置也可以通过下面的配置入口使用。

默认运行不需要 Docker，也不启动单独的 OpenCode HTTP 服务。官方 SDK 在同一个 Bun 进程内执行，已在 Windows 上完成真实会话与恢复测试。

### 自定义模型提供方

在「连接与运行」选择 **Volcengine Agent Plan** 或 **自定义 OpenAI 兼容提供方**，填写名称、ID、Base URL 和 API Key。Agent Plan 预填 `https://ark.cn-beijing.volces.com/api/plan/v3`；其他兼容服务可自由修改地址。

「获取模型」使用 Bearer Key 请求 `{Base URL}/models`，从结果中搜索、添加需要的模型，也支持直接填写模型 ID。部分服务（包括目前的 Agent Plan）不提供标准模型列表接口，此时根据服务商文档手动填写；不会换用其他计费入口或把固定名单冒充查询结果。此入口用于 Chat Completions 兼容的对话模型。

保存后 OpenCode 自动重载，模型可用于新建会话和账号绑定；已配置的提供方可再次编辑。配置保存在 Ineffa 使用的 OpenCode 配置目录中，API Key 不返回浏览器，编辑时留空保留；改换 Base URL 时需重新输入 Key。若关闭了 OpenCode 文件监听，界面会提示保存后需要重启。模型列表只在设置中获取，不增加聊天时的请求。

展开已配置提供方的模型列表可删除单个模型；提供方旁的删除按钮可移除整组配置。账号绑定或未归档会话仍在使用时，需先切换模型或归档会话。删除最后一个模型保留提供方和 Key，删除整个提供方才移除 Key；会话历史始终保留。

内置提供方也可删除已保存的连接凭据。“已配置”表示保存了凭据，不表示账号当前使用它或 API 已验证可用；环境变量提供的连接需在运行环境中移除。

### KOOK

在 WebUI 的「连接与运行 → 添加 KOOK 账号」填写 Bot Token、工作目录，以及信任的服务器 ID（Guild ID）或允许的频道 ID。信任服务器后，其内 Bot 可访问的全部频道（含新频道）均允许接收消息；频道列表可额外放行其他服务器的指定频道。配置文件使用 `guilds: ['服务器数字ID']`，与 `channels` 取并集。两者均为空时不接收群聊，未配置 `guilds` 的旧账号保持原有范围。频道里仍需明确 mention 才回复；私聊独立按用户 ID 列表控制。修改访问列表保存后自动重连生效。

- `频道 × Bot 账号` 固定对应一个 OpenCode 会话，首次收到有效消息时出现在会话列表。
- 未 @ 的频道消息只保存，不调用模型；下次 @ 时按时间顺序随当前提问补入上下文。每个 Bot 独立读取，重启保留，`/new` 从空白开始；不自动回补服务离线期间的历史。
- 发言携带显示名称、平台 ID、用户 / Bot、mention 和可用的引用信息，支持区分同名用户。命令与调试状态不进入背景。
- A 可以在回复中用 `(met)平台用户ID(met)` 提及 B、C。系统上下文包含当前账号及同频道账号的显示名称、真实平台 ID 和原生 mention 写法。
- **已确认发送到频道的最终回复**会唤醒被提及的已注册 Bot，其余同频道 Bot 只保存背景。外部 Bot 不自动触发回复；代码块、引用、转义文本和普通 `@名字` 不触发唤醒。
- B、C 的汇报进入 A 原来的会话。默认排队，A 自己此前的发言、工具与执行结果仍由 OpenCode 保留。
- KOOK 发言在 KOOK 原频道进行。WebUI 提供查看、停止、排队输入管理、权限回复与显式重置。
- 浏览器和 KOOK 均支持流式输出；KOOK 以 500 ms 合并更新同一条消息，超过 7,500 字符的最终回复上传为完整 Markdown 附件，附带原生 mention。

账号可在界面编辑和重连。已有活跃会话时，需先归档才能修改该账号的 Agent 或工作目录。API 不返回保存的 Token。由配置文件创建的账号在原文件修改，重启生效。

### 账号模型

在添加或编辑账号时选择「绑定模型」，可搜索该工作目录中已配置的模型。保存后同步到该账号所有未归档会话，保留会话历史，不打断正在生成的请求；后续模型请求使用新模型。新会话和 `/new` 也使用绑定模型，其他账号及归档历史不受影响。

未绑定时沿用 OpenCode 默认设置和会话自己的模型选择；解除绑定保留已有会话的当前模型。绑定期间在账号设置统一修改，WebUI 不再提供该会话的独立模型切换。

该配置属于通用 `AccountProfile.model` / `Adapter.model`，不限定 KOOK。TypeScript 配置使用 `model: 'provider/model-id'`；重启会将配置同步到已有未归档会话。

## 斜杠命令与流式回复

- `/new`：停止执行、清理队列，归档旧会话，沿用 Agent 和模型开启新会话。
- `/abort`：立即停止当前输出并清空排队输入，保留当前会话、历史和设置；已完成的工具操作不会撤销。
- `/help`：查看本地命令。
- `/debug on|off`：开关当前账号、当前会话的简短耗时统计；重启和 `/new` 保留开关。

群聊需明确 @ 账号；不转发 `/review`、`/init` 或其他 OpenCode 命令。命令、确认、状态消息及 debug 报告均不写入模型上下文。

正文流式更新同一条消息，工具与 Thinking 各自独立一条：`(1.223 k) grep x1, shell x2`、`(1.223 k) Think in progress`。统计本轮输出 Token（含 Thinking），随 OpenCode 用量更新：小于 1,000 用 `tks`，小于 1,000,000 换算为 `k`，其余换算为 `Mtks`，最多三位小数。尚未返回统计时显示 `— tks`。平台更新合并 500 ms 内的增量，最终正文确认送达后才转交 Agent mention。不支持编辑的 Adapter 在结束后发送完整消息。

Debug 的连接/响应头显示本轮请求的最小、最大、平均耗时，计时从发起模型 HTTP 请求到收到响应头，包含网络及服务端等待。首字从本轮首次模型请求起算，到收到远端第一个完整 SSE 事件为止（包括角色、Thinking、工具事件，忽略心跳注释）；未收到 SSE 时显示未采集。总计和工具累计耗时使用 `26h 11m 1s` 格式，省略前导零单位，不足一秒显示 `0s`。工具耗时按调用相加，可能包含权限等待。仅调试会话启用 HTTP 计时与流观察，OpenCode 可能改用 HTTP；关闭后恢复原传输选择。重启后未完成的计时仅统计重新采集的部分。

`缓存命中 82.4%` 表示本轮已完成模型请求的缓存读取 Token / 总输入 Token，工具前后多次请求按 Token 数加权，不包含输出 Token。直接使用 OpenCode 用量事件，不额外请求上游；OpenCode 的总输入为 `input + cache.read + cache.write`。SDK 无法区分零命中与未上报，均显示 `缓存命中 —`；失败且无用量时也显示 `—`。它反映上游返回的用量，不保证供应商实际缓存策略。新群聊背景追加在输入尾部，已有历史不重写；更换模型、修改提示词或同频道账号名单、上下文压缩仍可能改变可复用前缀。

## 账号身份与提示词

「Agent 身份」和「该做什么」是所有 Adapter 共用的账号配置，由通用 `AccountProfile` / `Adapter` 接口承载。两项均留空时使用所选 OpenCode Agent 的基础提示词；填写任一项后，以填写的内容替换基础提示词，保留 OpenCode 的环境、项目指令、工具与权限机制。当前 WebUI 提供 KOOK 账号的创建与编辑入口，其他 Adapter 可通过 TypeScript 配置接入同一能力。

- `{displayName}`：账号配置的「显示名称」，未填写时使用 Ineffa 账号 ID。
- `{platformId}`：Adapter 确认的真实平台账号 ID，不是 Ineffa 的配置 ID。核心按字符串处理；在 KOOK 上它是数字 ID，其他平台可采用自己的 ID 格式。
- 宏在两项中都可使用，只替换一次；其他花括号内容保持原样。

例如：身份填 `你是 {displayName}，平台账号 ID 为 {platformId}。`，职责填 `负责核对资料来源，并通过 mention 向其他 Agent 汇报。`。配置文件对应 `agentPrompt: { identity: '…', task: '…' }`。

单独修改显示名称或提示词无需重连，在下一次模型请求（包括工具执行后的继续请求）生效；不重置会话历史，也不改写已完成的回复。已有历史中的旧指令不会被清洗。

同会话名单只列出本进程已识别平台身份、拥有该会话访问权限的其他账号，不公开它们的职责提示词。共享会话边界和 mention 格式由各 Adapter 定义；例如 KOOK 按 Channel 判断，不把两个 Bot 与同一用户的私聊合并。名单不依赖对方已经创建 OpenCode 会话，也不额外拉取平台全员列表。

## 配置

普通使用无需配置文件。需要自定义组合时，复制 `ineffa.config.example.ts` 为 `ineffa.config.ts`；它是 TypeScript 入口，可以直接组合 Adapter 与 OpenCode 原生选项。

```ts
import type { AppConfig } from "./src/config";

export default {
  directory: "workspace",
  opencode: {
    config: {
      content: JSON.stringify({
        model: "custom/your-model-id",
        providers: {
          custom: {
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: {
              baseURL: "https://your-provider.example/v1",
              apiKey: process.env.MODEL_API_KEY,
            },
            models: { "your-model-id": {} },
          },
        },
      }),
    },
  },
} satisfies AppConfig;
```

Skills、MCP、Agent 和工具权限使用 [OpenCode 自身的配置与插件](https://opencode.ai/v2/docs/build/sdk)，不增加 Ineffa 专用配置格式。`host.engine.native` 与 KOOK Adapter 的 `.native` 保留完整原生接口。平台历史读取也由 Adapter 提供，但不会自动插入每一轮输入。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `INEFFA_HOST` | `127.0.0.1` | 监听地址 |
| `INEFFA_PORT` | `4097` | HTTP 端口 |
| `INEFFA_TOKEN` | 未设置 | WebUI / API 访问令牌；监听非本地地址时必填 |
| `INEFFA_DATA_DIR` | `.ineffa` | 状态与凭据目录 |
| `INEFFA_CONFIG` | `ineffa.config.ts` | 可选配置入口 |
| `INEFFA_PUBLIC_ORIGIN` | 未设置 | 反向代理的公开源，如 `https://ineffa.example.com` |

Bun 会读取项目 `.env`。WebUI 使用 HttpOnly、SameSite=Strict Cookie，API 也接受 `Authorization: Bearer <token>`。服务拒绝跨源浏览器请求。该界面面向单个可信工作空间的所有者，不提供多租户隔离；平台访问列表控制哪些人可以发起工作，实际工具权限由 OpenCode 执行并在 WebUI 请求授权。

## 持久化与恢复

```text
.ineffa/
  owner.sqlite             # 单进程占用锁，崩溃时由操作系统释放
  ineffa.sqlite            # 地址绑定、入站去重、发送确认与事件游标
  accounts.json            # WebUI 保存的 KOOK 账号，含凭据
  opencode/
    opencode.sqlite        # OpenCode 自有会话、输入队列与执行记录
    config/                # OpenCode 配置目录
workspace/                 # Agent 的工作文件
```

OpenCode SDK 默认使用内存数据库；Ineffa 显式指定持久化路径。每条输入的稳定 ID 会传给 OpenCode，服务恢复时重试接收操作不会创建第二条输入。已确认的公开回复不会重发。发送中崩溃或超时时，记录变为「结果待核实」，可以在 WebUI 核实后继续。

同一数据目录只允许一个 Ineffa 进程，同一平台 Bot 身份只能由一个账号实例持有。默认每轮协作最多自动唤醒 12 次，每个会话最多 128 条排队输入；这些是可见的资源边界，不判断任务是否完成。每条发给指定 Agent 的人类输入开启一条触发链，其后所有分支共享预算；同一人类消息直接唤醒多个 Agent 时，各自起链。显式重置归档旧会话，旧协作的迟到汇报不会唤醒新会话。

备份时先正常停止服务，再一起复制**整个数据目录与工作目录**，包括凭据、插件所用文件和可能存在的 SQLite WAL 文件。恢复时使用配套的锁文件与相同 SDK 版本。升级依赖前备份并运行回归检查，不混用不同版本的数据库备份。

## Docker（可选）

一个容器包含 Ineffa 与进程内 OpenCode，两个持久卷保存数据与工作文件。

### 本地镜像包（无需公开仓库）

在装有 Bun 和 Docker 的开发机器打包：

```sh
bun run docker:pack              # Linux x86-64
# bun run docker:pack linux/arm64 # ARM64 目标机器
```

生成 `release/ineffa-时间戳-架构/`，包含压缩镜像、`compose.yaml`、独立随机登录令牌的 `.env` 和启动说明。不会上传镜像，也不打入本机的账号、密钥、会话和工作文件。

把整个文件夹（包括隐藏的 `.env`）复制到有 Docker Compose 的同架构目标机器，然后在该文件夹执行：

```sh
docker load -i ineffa-image.tar.gz
docker compose up -d
```

打开 `http://127.0.0.1:4097`，使用包内 `.env` 的 `INEFFA_TOKEN` 登录，在界面配置模型与平台账号。工作目录使用 `/app/workspace`。不需要源码仓库、Bun 或 npm，也不会自动从镜像仓库拉取；模型和 KOOK 连接仍需联网。

远程机器可以用 `ssh -L 4097:127.0.0.1:4097 用户@服务器` 转发后，从自己电脑访问上述网址。更新时导入新镜像，在原部署目录 `.env` 中仅更改 `INEFFA_IMAGE`，再运行 `docker compose up -d`；保留原令牌和数据卷，不使用 `down -v`。

### 从源码构建

1. 复制 `.env.example` 为 `.env`，设置自己的随机 `INEFFA_TOKEN`。
2. 启动：

```sh
docker compose up --build -d
docker compose logs -f
```

默认端口仅发布到主机 `127.0.0.1:4097`。要从外部访问，可使用 HTTPS 反向代理并配置 `INEFFA_PUBLIC_ORIGIN`。容器中的 Agent 工作路径为 `/app/workspace`；需要其他项目时自行挂载到明确的目录。

源码目录的 Compose 复用 `deploy/compose.yaml` 并加入本地构建步骤。发布包只包含运行配置，默认以非 root 用户运行，仅映射本机的一个 Web 端口。

可用 `bun run scripts/docker-smoke.ts release/部署包目录` 验证容器启动、访问鉴权，以及容器重建后的会话和文件持久化。检查使用独立临时数据卷，默认占用本机 14097 端口，结束后自动清理。

## 开发与检查

Web 使用 Vite 和 React Fast Refresh。开发时在两个终端分别运行：

```sh
bun run dev       # 后端 http://127.0.0.1:4097，后端代码保存后重启
bun run dev:web   # Web http://127.0.0.1:5173，前端代码保存后热更新
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173) 开发 Web。保存 `web/` 中的 CSS、React 组件后，浏览器自动更新；React Fast Refresh 在支持的情况下保留组件状态。接口和消息事件流通过 Vite 的 `/api/` 代理连接 `4097` 后端。

如果后端已经在 `4097` 运行，只需启动 `bun run dev:web`。直接访问 `4097` 看到的是 `dist/` 中的构建结果，需要 `bun run build` 才会更新。

```sh
bun run check     # 类型检查、集成测试、WebUI 构建
```

测试使用本地可控的模型接口驱动真实 OpenCode SDK，不消耗外部模型配额。覆盖 A/B/C 异步汇报、queue 顺序、重复输入、重启历史、已确认回复去重、未知发送、原生 mention、访问控制及 Web API。Windows 的 Bun SQLite 句柄可能保留至进程退出，测试入口在子进程结束后清理自己的测试目录。

`bun run test:ui` 在 `127.0.0.1:4098` 启动独立的本地联调服务，使用临时数据。正式服务不包含演示消息或模型回复。浏览器已验证桌面 / 手机布局、创建和发送、历史展示、对话框焦点，以及发送响应丢失后刷新并重试仍不重复执行。没有提供实际 KOOK Token，因此尚未完成真实账号的网关、断网重连和配额压力验证；单元测试验证的是 Adapter 协议边界。

## 结构

```text
packages/ineffa/src/        # Host、OpenCode 薄接入、Delivery、SQLite Store
packages/ineffa-kook/src/   # KOOK SDK 接线、原生 mention、平台发送
src/                       # 单进程服务、配置、HTTP / SSE、Web Adapter
web/                       # React + CakeUI
tests/                     # 真实 SDK 集成与协议边界测试
```

[ARCH.md](ARCH.md) 记录职责划分与取舍。WebUI 遵循 [CakeDesign](https://raw.githubusercontent.com/hatsune-miku/cakedesign-skill/refs/heads/main/SKILL.md)，使用 [CakeUI](https://www.npmjs.com/package/@a1knla/cakeui) 与[官方组件文档](https://gallery.vanillacake.cn/llms.txt)：低饱和蓝、浅灰白底、本地托管的 Noto Sans SC、无 Tailwind。

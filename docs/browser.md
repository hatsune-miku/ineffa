# 浏览器

Ineffa 使用官方 [Playwright MCP](https://github.com/microsoft/playwright-mcp)，通过 OpenCode 原生 MCP 执行浏览器操作。无需桌面环境、OpenCode 桌面端或额外监听端口。

## 安装

安装 Node.js 20+ 和项目依赖后，以运行 Ineffa 的系统用户执行：

```sh
bun run browser:install
```

Linux 首次部署可同时安装系统依赖（安装系统包需要管理员权限）：

```sh
bun run browser:install --with-deps
```

升级依赖后重新执行安装命令，让 Chromium 与锁定的 Playwright 版本匹配。服务不会在每次启动时下载浏览器。

## 使用与隔离

- `list_browser_tools` 发布可用的浏览器工具，工具名以 `ineffa_browser_` 开头。旧的桌面专用 `browser_tabs_list` 等工具不再注册。
- MCP 子进程由 OpenCode 管理，Chromium 首次使用时启动；服务停止时一并关闭。
- 浏览器按 OpenCode 工作目录共享。同目录的账号和会话共享标签页及登录状态，需要隔离时请为账号设置不同工作目录。
- 使用临时浏览器配置；关闭浏览器、空闲回收或服务重启后不保留登录状态。`/new` 只重置对话，不清理同目录共享的浏览器。`/debug` 不重建浏览器。
- 截图及下载文件保存在工作目录内，可通过 `send_file` 发给当前平台用户。
- 浏览器访问服务器所在网络；`localhost` 指运行 Ineffa 的机器。

高级配置可用 `opencode.browser: false` 关闭内置浏览器，仍可独立使用 `webfetch`。需要自定义启动命令时，先关闭默认浏览器，再通过 OpenCode 的 `mcp.servers.ineffa_browser` 配置自己的 MCP 服务。

真实浏览器回归测试：安装 Chromium 后，设置环境变量 `INEFFA_TEST_BROWSER=1`，运行 `bun test tests/browser.test.ts`。

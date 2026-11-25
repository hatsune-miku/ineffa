# 浏览器

OpenCode 和 Pi 均通过各自的原生 MCP 客户端执行浏览器操作。浏览器可在无桌面环境的服务器上运行。[Playwright MCP](https://github.com/microsoft/playwright-mcp)

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

- `list_browser_tools` 返回当前后端的浏览器工具名和输入参数。Pi 在发现工具时连接 MCP，Chromium 在首次浏览操作时启动。
- Pi 每个原生会话使用独立浏览器。归档、重置或从 Pi 切走会释放对应连接，新会话使用新的标签页和登录状态。
- OpenCode 按工作目录共享浏览器，`/new` 后仍可访问同目录的标签页。需要隔离时可为账号设置不同工作目录。
- 两个后端都使用临时浏览器配置，服务重启后需重新登录。`/debug` 保留当前浏览器。
- 截图及下载文件保存在工作目录内，可通过 `send_file` 发给当前平台用户。
- 浏览器访问服务器所在网络；`localhost` 指运行 Ineffa 的机器。

高级配置可用 `opencode.browser: false` 关闭内置浏览器，仍可独立使用 `webfetch`。需要自定义启动命令时，先关闭默认浏览器，再通过 OpenCode 的 `mcp.servers.ineffa_browser` 配置自己的 MCP 服务。

安装 Chromium 后，设置环境变量 `INEFFA_TEST_BROWSER=1`，运行 `bun test tests/browser.test.ts tests/pi-resources.test.ts` 可验证两个后端的实际浏览操作。

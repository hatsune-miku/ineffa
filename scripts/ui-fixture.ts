import { join } from 'node:path'

import { AccountsConfig } from '../src/config'
import { createServer } from '../src/server'
import { webAdapter } from '../src/web-adapter'
import { fixture } from '../tests/fixture'

// A local-only manual UI test server. It never calls an external model or messaging account.
const f = await fixture(
  async (request) => {
    await Bun.sleep(350)
    const previous = request.messages.filter((m) => m.role === 'assistant').length
    return previous
      ? '已沿用这个会话中的历史记录。\n\n你可以继续补充细节，也可以把新的主题放进另一个会话。'
      : '会话已接通。\n\n## 这次联调确认\n\n- 输入已进入真实的 OpenCode 会话。\n- 历史记录由 OpenCode 保存。\n- 页面可以展示回复与待处理输入。\n\n```ts\nconst session = await host.sessions.get({ sessionID });\n```\n\n这是本地测试接口生成的回复。'
  },
  {},
  0,
  true
)
await f.host.addAdapter(webAdapter(f.workspace))
const app = createServer(f.host, {
  directory: f.workspace,
  accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
  port: 4098,
})
console.log(`Local UI fixture: ${app.server.url}`)
console.log(`Local model endpoint: http://127.0.0.1:${f.server.port}/v1`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await app.close()
  await f.close()
}
process.on('SIGINT', () => void close())
process.on('SIGTERM', () => void close())

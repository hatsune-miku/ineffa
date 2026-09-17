import { Host, OpenCodeBridge, Store } from 'ineffa'
import { kook } from 'ineffa-kook'
import { resolve } from 'node:path'

import { AccountsConfig, prepareDirectories, readConfig } from './config'
import { acquireOwnership } from './ownership'
import { createServer } from './server'
import { webAdapter } from './web-adapter'

const config = await readConfig()
const { dataDirectory, directory } = await prepareDirectories(config)
const releaseOwnership = acquireOwnership(dataDirectory)
const accounts = new AccountsConfig(resolve(dataDirectory, 'accounts.json'))
const savedAccounts = await accounts.load()
const store = new Store(resolve(dataDirectory, 'ineffa.sqlite'))
const engine = await OpenCodeBridge.open(resolve(dataDirectory, 'opencode'), config.opencode)
const host = new Host(store, engine, config.limits)
await host.addAdapter(webAdapter(directory))
for (const adapter of [...(config.adapters ?? []), ...savedAccounts.map(kook)]) await host.addAdapter(adapter)
await host.start()
const service = createServer(host, {
  hostname: process.env.INEFFA_HOST,
  port: Number(process.env.INEFFA_PORT ?? 4097),
  token: process.env.INEFFA_TOKEN,
  publicOrigin: process.env.INEFFA_PUBLIC_ORIGIN,
  directory,
  accounts,
})
console.log(`Ineffa: ${service.server.url}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await service.close()
  await host.close()
  releaseOwnership()
}
process.on('SIGINT', () => {
  void close()
})
process.on('SIGTERM', () => {
  void close()
})

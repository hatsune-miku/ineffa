import { Host, IneffaError, errorMessage, identity, modelReference, sourceInputId } from 'ineffa'
import { kook } from 'ineffa-kook'
import { createHash, timingSafeEqual } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AccountsConfig, validateAccount } from './config'
import { ConfigTransfer } from './config-transfer'
import { ProviderSettings } from './providers'
import { messageView } from './view'

export interface ServerOptions {
  hostname?: string
  port?: number
  token?: string
  publicOrigin?: string
  dist?: string
  directory: string
  accounts: AccountsConfig
}
function hash(value: string) {
  return createHash('sha256').update(value).digest()
}
function equal(a: string, b: string) {
  return timingSafeEqual(hash(a), hash(b))
}
function text(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new IneffaError('invalid_input', `${label}不能为空且不能超过 ${max} 字符。`)
  return value.trim()
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new IneffaError('invalid_content_type', '请求必须使用 application/json。', 415)
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new IneffaError('invalid_json', '请求正文不是有效的 JSON 对象。')
  }
}
export function createServer(host: Host, options: ServerOptions) {
  const hostname = options.hostname ?? '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) && !options.token)
    throw new Error('监听外部地址时必须设置 INEFFA_TOKEN。')
  const cookie = options.token ? hash(`ineffa-session:${options.token}`).toString('hex') : ''
  const clients = new Set<() => void>()
  const dist = resolve(options.dist ?? 'dist')
  const providers = new ProviderSettings(host.engine, assertModelsUnused)
  const transfer = new ConfigTransfer(host, options.accounts, options.directory)
  let configurationWrites = Promise.resolve()
  async function assertModelsUnused(providerId: string, models?: string[]) {
    function matches(value?: string) {
      const model = modelReference(value)
      return model?.providerID === providerId && (!models || models.includes(model.id))
    }
    for (const adapter of host.adapters.values()) {
      if (matches(adapter.model)) {
        throw new IneffaError('model_in_use', `账号「${adapter.name}」仍绑定此模型，请先更改账号绑定。`, 409)
      }
    }
    for (const binding of host.store.bindings()) {
      if (!binding.engineReady) continue
      const session = await host.engine.native.sessions.get({ sessionID: binding.sessionId })
      if (session.model && matches(`${session.model.providerID}/${session.model.id}`)) {
        throw new IneffaError(
          'model_in_use',
          `会话「${binding.address.title}」仍使用此模型，请先切换模型或归档会话。`,
          409
        )
      }
    }
  }
  async function validateAccountModel(directory: string, value?: string) {
    const model = modelReference(value)
    if (!model) return
    await host.engine.ready(directory)
    const models = await host.engine.native.model.list({ location: { directory } })
    if (!models.data.some((item) => item.providerID === model.providerID && item.id === model.id))
      throw new IneffaError('invalid_model', '此模型在账号工作目录中不可用，请先配置模型提供方。')
  }
  function authenticate(request: Request) {
    if (!options.token) return true
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '')
    const session = request.headers
      .get('cookie')
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ineffa_session='))
      ?.slice(15)
    return Boolean((bearer && equal(bearer, options.token)) || (session && equal(session, cookie)))
  }
  const server = Bun.serve({
    hostname,
    port: options.port ?? 4097,
    idleTimeout: 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      let releaseConfiguration: (() => void) | undefined
      try {
        const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin).origin : undefined
        const localNames = ['localhost', '127.0.0.1', '[::1]', hostname]
        if (!publicOrigin && !localNames.includes(url.hostname))
          throw new IneffaError('invalid_host', '请求的主机名不受此服务信任。', 403)
        const origin = request.headers.get('origin')
        if (origin && origin !== (publicOrigin ?? url.origin))
          throw new IneffaError('invalid_origin', '拒绝来自其他网站的请求。', 403)
        if (request.headers.get('sec-fetch-site') === 'cross-site')
          throw new IneffaError('cross_site_request', '拒绝跨站访问。', 403)
        if (path === '/api/login' && request.method === 'POST') {
          const data = await body(request)
          if (!options.token || !equal(String(data.token ?? ''), options.token))
            throw new IneffaError('invalid_token', '访问令牌不正确。', 401)
          return Response.json(
            { ok: true },
            {
              headers: {
                'Set-Cookie': `ineffa_session=${cookie}; HttpOnly; SameSite=Strict; Path=/${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`,
              },
            }
          )
        }
        if (path === '/api/auth') return Response.json({ authenticated: authenticate(request) })
        if (path.startsWith('/api/') && !authenticate(request))
          throw new IneffaError('unauthorized', '需要访问令牌。', 401)
        if (request.method === 'POST' && /^\/api\/(config|providers|integrations|adapters)(\/|$)/.test(path)) {
          const previous = configurationWrites
          configurationWrites = new Promise<void>((resolve) => {
            releaseConfiguration = resolve
          })
          await previous
        }
        if (path.startsWith('/api/config/') && request.method === 'POST') {
          if (path === '/api/config/cancel') {
            await transfer.cancel()
            return Response.json({ ok: true })
          }
          if (path === '/api/config/export') {
            return Response.json(await transfer.export(), {
              headers: {
                'Cache-Control': 'no-store',
                'Content-Disposition': 'attachment; filename="ineffa-config.json"',
              },
            })
          }
          const data = await body(request)
          if (path === '/api/config/preview') {
            return Response.json(await transfer.preview(data.archive), { headers: { 'Cache-Control': 'no-store' } })
          }
          if (path === '/api/config/import') {
            return Response.json(await transfer.stage(data.archive, data.revision, data.choices), {
              headers: { 'Cache-Control': 'no-store' },
            })
          }
        }
        if (path === '/api/config/status') return Response.json({ pending: await transfer.pending() })
        if (
          request.method === 'POST' &&
          /^\/api\/(providers|integrations|adapters)(\/|$)/.test(path) &&
          (await transfer.pending())
        ) {
          throw new IneffaError('import_pending', '配置导入已保存，请重启服务后再编辑配置。', 409)
        }
        const attachmentMatch = /^\/api\/attachments\/(out_[a-f0-9]+)\/(\d+)$/.exec(path)
        if (attachmentMatch && request.method === 'GET') {
          const output = host.store.output(attachmentMatch[1]!)
          const attachment = output?.files?.[Number(attachmentMatch[2])]
          if (!attachment?.uri.startsWith('file:')) throw new IneffaError('attachment_not_found', '附件不存在。', 404)
          const target = fileURLToPath(attachment.uri)
          const local = relative(resolve(dirname(host.engine.databasePath), 'attachments'), target)
          if (!local || isAbsolute(local) || local.startsWith('..'))
            throw new IneffaError('attachment_forbidden', '无法访问此附件。', 403)
          const file = Bun.file(target)
          if (!(await file.exists())) throw new IneffaError('attachment_not_found', '附件不存在。', 404)
          return new Response(file, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name ?? 'attachment')}`,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          })
        }
        if (path === '/api/health')
          return Response.json({
            status: 'ready',
            runtime: 'bun',
            engine: 'embedded',
            version: '0.1.0',
            opencode: '2.0.3',
          })
        if (path === '/api/events') {
          const encoder = new TextEncoder()
          let dispose: () => void
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              let closed = false
              function send(value: unknown) {
                if (closed) return
                // Drop a slow UI connection; it reloads authoritative messages when it reconnects.
                if ((controller.desiredSize ?? 0) < -64) {
                  dispose()
                  return
                }
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
                } catch {
                  dispose()
                }
              }
              const unsubscribe = host.subscribe(send)
              const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 20_000)
              function closeConnection() {
                if (closed) return
                closed = true
                clearInterval(heartbeat)
                unsubscribe()
                clients.delete(closeConnection)
                request.signal.removeEventListener('abort', closeConnection)
                try {
                  controller.close()
                } catch {}
              }
              dispose = closeConnection
              clients.add(dispose)
              request.signal.addEventListener('abort', dispose, { once: true })
              send({ type: 'connected' })
            },
            cancel() {
              dispose()
            },
          })
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
              'X-Accel-Buffering': 'no',
            },
          })
        }
        if (path === '/api/sessions' && request.method === 'GET') {
          const active = await host.engine.native.sessions.active()
          return Response.json({
            sessions: host.store.bindings(url.searchParams.get('archived') === 'true').map((binding) => ({
              ...binding,
              running: Boolean(active[binding.sessionId]),
              platform: host.adapters.get(binding.adapterId)?.platform ?? 'unavailable',
            })),
          })
        }
        if (path === '/api/sessions' && request.method === 'POST') {
          const data = await body(request)
          const name = text(data.title, '会话名称', 120)
          const agent = typeof data.agent === 'string' ? data.agent : 'build'
          await host.engine.ready(options.directory)
          const available = await host.engine.native.agent.list({ location: { directory: options.directory } })
          if (!available.data.some((item) => item.id === agent))
            throw new IneffaError('agent_not_found', '所选 Agent 不存在。')
          if (data.model) {
            const models = await host.engine.native.model.list({ location: { directory: options.directory } })
            if (!models.data.some((m) => `${m.providerID}/${m.id}` === data.model))
              throw new IneffaError('invalid_model', '所选模型当前不可用，请检查提供方连接。')
          }
          const binding = await host.createConversation(
            'web',
            { id: `web:${crypto.randomUUID()}`, title: name, kind: 'direct' },
            agent
          )
          if (typeof data.model === 'string' && data.model) {
            const slash = data.model.indexOf('/')
            if (slash < 1) throw new IneffaError('invalid_model', '模型标识必须是 provider/model。')
            await host.engine.native.sessions.switchModel({
              sessionID: binding.sessionId,
              model: { providerID: data.model.slice(0, slash), id: data.model.slice(slash + 1) },
            })
          }
          return Response.json(binding, { status: 201 })
        }
        const match = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path)
        if (match) {
          const binding = host.store.binding(match[1]!)
          const action = match[2] ?? ''
          const sessionID = binding.sessionId
          if (action === '' && request.method === 'GET') {
            const [info, page, pending, permissions, forms, active] = await Promise.all([
              host.engine.native.sessions.get({ sessionID }),
              host.engine.messages(sessionID, url.searchParams.get('cursor') ?? undefined),
              host.engine.pending(sessionID),
              host.engine.native.permission.list({ sessionID }),
              host.engine.native.form.list({ sessionID }),
              host.engine.native.sessions.active(),
            ])
            const rows = page.data
              .map((message) =>
                messageView(message, host.store.inbound(sourceInputId(message)), host.store.debugReport(message.id))
              )
              .filter(Boolean)
              .reverse()
            if (!url.searchParams.has('cursor')) {
              rows.push(
                ...host.store.observed(binding.id, false).map((input) => ({
                  id: input.id,
                  role: 'user' as const,
                  text: input.message.text,
                  author: `${input.message.author.name} · ${input.message.author.id}${input.message.author.bot ? ' · Bot' : ''}`,
                  files: input.message.files,
                  createdAt: input.message.createdAt,
                  completed: true,
                }))
              )
              rows.push(
                ...host.store.commandNotices(binding.id).map((notice) => ({
                  id: notice.id,
                  role: notice.kind === 'attachment' ? ('assistant' as const) : ('system' as const),
                  text: notice.text,
                  files: notice.files?.map((file, index) => ({
                    name: file.name,
                    uri: `/api/attachments/${notice.id}/${index}`,
                  })),
                  createdAt: notice.createdAt,
                  completed: notice.complete,
                }))
              )
              rows.sort((left, right) => left!.createdAt - right!.createdAt)
            }
            return Response.json({
              binding,
              accountModel: host.adapters.get(binding.adapterId)?.model,
              info: {
                agent: info.agent,
                model: info.model,
                tokens: info.tokens,
                cost: info.cost,
                outcome: info.outcome,
              },
              messages: rows,
              cursor: page.data.length >= 100 ? page.cursor.next : null,
              running: Boolean(active[sessionID]),
              pending: pending.map((item) => ({
                id: item.id,
                delivery: item.delivery,
                type: item.type,
                text:
                  host.store.inbound(item.id)?.message.text ??
                  ('text' in item.payload ? item.payload.text : '控制请求'),
              })),
              permissions,
              forms,
            })
          }
          if (request.method === 'POST') {
            const data = await body(request)
            if (
              binding.archivedAt &&
              action === 'messages' &&
              binding.adapterId === 'web' &&
              typeof data.id === 'string'
            ) {
              const previous = host.store.inbound(identity('msg_', 'web', binding.address.id, data.id))
              if (previous) return Response.json(previous, { status: 202 })
            }
            if (binding.archivedAt && !['permission', 'form', 'delete'].includes(action))
              throw new IneffaError('archived', '此会话已归档，请创建或选择新的会话。', 409)
            if (action === 'messages') {
              if (binding.adapterId !== 'web')
                throw new IneffaError('platform_input_required', '请在对应平台发送消息，以保留公开的讨论记录。', 409)
              const content = text(data.text, '消息')
              const messageId = text(data.id, '消息 ID', 128)
              if (data.mode !== undefined && data.mode !== 'queue' && data.mode !== 'steer')
                throw new IneffaError('invalid_mode', '输入方式只能是 queue 或 steer。')
              const result = await host.receive('web', {
                id: messageId,
                address: binding.address,
                author: { id: 'owner', name: '你', bot: false },
                text: content,
                mentions: [],
                createdAt: Date.now(),
                mode: data.mode as 'queue' | 'steer' | undefined,
              })
              return Response.json(result, { status: 202 })
            }
            if (action === 'stop') {
              await host.stop(binding.id, data.cancelQueued !== false)
              return Response.json({ ok: true })
            }
            if (action === 'reset') return Response.json(await host.reset(binding.id))
            if (action === 'rename') {
              const title = text(data.title, '会话名称', 120)
              await host.engine.native.sessions.rename({ sessionID, title })
              host.store.rename(binding.id, title)
              host.emit({ type: 'change' })
              return Response.json({ ok: true })
            }
            if (action === 'model') {
              if (host.adapters.get(binding.adapterId)?.model)
                throw new IneffaError(
                  'account_model_bound',
                  '此会话使用账号绑定的模型，请在账号设置中修改或解除绑定。',
                  409
                )
              const model = text(data.model, '模型')
              const models = await host.engine.native.model.list({ location: { directory: binding.directory } })
              const selected = models.data.find((m) => `${m.providerID}/${m.id}` === model)
              if (!selected) throw new IneffaError('invalid_model', '所选模型当前不可用。')
              await host.engine.native.sessions.switchModel({
                sessionID,
                model: { providerID: selected.providerID, id: selected.id },
              })
              host.emit({ type: 'change', bindingId: binding.id })
              return Response.json({ ok: true })
            }
            if (action === 'archive') {
              await host.archive(binding.id)
              return Response.json({ ok: true })
            }
            if (action === 'delete') {
              await host.removeConversation(binding.id)
              return Response.json({ ok: true })
            }
            if (action === 'queue/cancel' || action === 'queue/steer') {
              const inboxID = text(data.id, '输入 ID', 128)
              if (action.endsWith('cancel')) {
                await host.engine.native.sessions.inbox.cancel({ sessionID, inboxID })
                if (host.store.inbound(inboxID)) host.store.inboundState(inboxID, 'cancelled')
              } else await host.engine.native.sessions.inbox.steer({ sessionID, inboxID })
              host.emit({ type: 'change', bindingId: binding.id })
              return Response.json({ ok: true })
            }
            if (action === 'permission') {
              if (!['once', 'always', 'reject'].includes(String(data.reply)))
                throw new IneffaError('invalid_reply', '权限回复无效。')
              await host.engine.native.permission.reply({
                sessionID,
                requestID: text(data.id, '请求 ID'),
                reply: data.reply as 'once' | 'always' | 'reject',
              })
              host.emit({ type: 'change', bindingId: binding.id })
              return Response.json({ ok: true })
            }
            if (action === 'form') {
              const formID = text(data.id, '表单 ID')
              if (data.cancel) await host.engine.native.form.cancel({ sessionID, formID })
              else {
                if (!data.answer || typeof data.answer !== 'object' || Array.isArray(data.answer))
                  throw new IneffaError('invalid_answer', '表单回复格式不正确。')
                await host.engine.native.form.reply({
                  sessionID,
                  formID,
                  answer: data.answer as Record<string, string | number | boolean | string[]>,
                })
              }
              host.emit({ type: 'change', bindingId: binding.id })
              return Response.json({ ok: true })
            }
          }
        }
        if (path === '/api/catalog') {
          const directory = url.searchParams.get('directory')
          const location = { directory: directory ? resolve(text(directory, '工作目录')) : options.directory }
          await host.engine.ready(location.directory)
          const [agents, models, integrations] = await Promise.all([
            host.engine.native.agent.list({ location }),
            host.engine.native.model.list({ location }),
            host.engine.native.integration.list({ location }),
          ])
          return Response.json({
            providers: await providers.list(),
            agents: agents.data
              .filter((agent) => !agent.hidden && agent.mode !== 'subagent')
              .map((agent) => ({ id: agent.id, name: agent.name, description: agent.description })),
            models: models.data.map((model) => ({
              id: `${model.providerID}/${model.id}`,
              name: model.name ?? model.id,
              provider: model.providerID,
            })),
            integrations: integrations.data.map((integration) => ({
              id: integration.id,
              name: integration.name,
              connected: integration.connections.length > 0,
              removable: integration.connections.some((connection) => connection.type === 'credential'),
              environment: integration.connections.flatMap((connection) =>
                connection.type === 'env' ? [connection.name] : []
              ),
              key: integration.methods.some((method) => method.type === 'key'),
            })),
          })
        }
        if (path === '/api/integrations/key' && request.method === 'POST') {
          const data = await body(request)
          await host.engine.native.integration.connect.key({
            integrationID: text(data.id, '提供方 ID'),
            key: text(data.key, 'API Key'),
            location: { directory: options.directory },
          })
          return Response.json({ ok: true })
        }
        if (path === '/api/integrations/delete' && request.method === 'POST') {
          const data = await body(request)
          const id = text(data.id, '提供方 ID')
          const location = { directory: options.directory }
          await host.engine.ready(location.directory)
          const { data: integration } = await host.engine.native.integration.get({ integrationID: id, location })
          if (!integration) throw new IneffaError('provider_not_found', '此提供方已不存在。', 404)
          const credentials = integration.connections.filter((connection) => connection.type === 'credential')
          if (!credentials.length) {
            if (integration.connections.some((connection) => connection.type === 'env'))
              throw new IneffaError('environment_connection', '此连接来自环境变量，请从服务运行环境移除对应变量。', 409)
            return Response.json({ restartRequired: false })
          }
          await assertModelsUnused(id)
          for (const credential of credentials)
            await host.engine.native.credential.remove({ credentialID: credential.id, location })
          host.emit({ type: 'change' })
          return Response.json({ restartRequired: false })
        }
        if (path === '/api/providers/discover' && request.method === 'POST') {
          return Response.json(await providers.discover(await body(request), request.signal))
        }
        if (path === '/api/providers' && request.method === 'POST') {
          const result = await providers.save(await body(request), options.directory)
          host.emit({ type: 'change' })
          return Response.json(result)
        }
        if (path === '/api/providers/delete' && request.method === 'POST') {
          const result = await providers.remove(await body(request), options.directory)
          host.emit({ type: 'change' })
          return Response.json(result)
        }
        if (path === '/api/adapters' && request.method === 'GET')
          return Response.json({
            adapters: [...host.adapters.values()].map((adapter) => ({
              id: adapter.id,
              name: adapter.name,
              platform: adapter.platform,
              agent: adapter.agent,
              model: adapter.model,
              directory: adapter.directory,
              identity: adapter.identity,
              agentPrompt: adapter.agentPrompt,
              capabilities: adapter.capabilities,
              editable: Boolean(options.accounts.get(adapter.id)),
              access: options.accounts.get(adapter.id)
                ? {
                    guilds: options.accounts.get(adapter.id)!.guilds,
                    channels: options.accounts.get(adapter.id)!.channels,
                    users: options.accounts.get(adapter.id)!.users,
                  }
                : undefined,
              status: host.statuses.get(adapter.id),
            })),
          })
        if (path === '/api/adapters' && request.method === 'POST') {
          const config = validateAccount(await body(request))
          if (host.adapters.has(config.id)) throw new IneffaError('duplicate_adapter', '账号 ID 已存在。', 409)
          await validateAccountModel(config.directory, config.model)
          await options.accounts.add(config)
          await host.addAdapter(kook(config))
          return Response.json({ id: config.id, status: host.statuses.get(config.id) }, { status: 201 })
        }
        const reconnect = /^\/api\/adapters\/([^/]+)\/reconnect$/.exec(path)
        if (reconnect && request.method === 'POST') {
          await host.adapter(reconnect[1]!).stop()
          await host.connect(reconnect[1]!)
          return Response.json({ ok: true })
        }
        const accountEdit = /^\/api\/adapters\/([^/]+)\/update$/.exec(path)
        if (accountEdit && request.method === 'POST') {
          const previous = options.accounts.get(accountEdit[1]!)
          if (!previous) throw new IneffaError('account_readonly', '此账号由配置文件管理，请在配置文件中修改。', 409)
          const data = await body(request)
          const config = validateAccount({
            ...previous,
            ...data,
            id: previous.id,
            token: typeof data.token === 'string' && data.token.trim() ? data.token : previous.token,
          })
          await validateAccountModel(config.directory, config.model)
          if (
            host.store.bindings().some((b) => b.adapterId === previous.id) &&
            (config.agent !== previous.agent || config.directory !== previous.directory)
          )
            throw new IneffaError('account_in_use', '此账号还有活跃会话。请先归档，再更改 Agent 或工作目录。', 409)
          await options.accounts.update(config)
          const adapter = host.adapters.get(previous.id)
          const connectionChanged = (['token', 'agent', 'directory', 'guilds', 'channels', 'users'] as const).some(
            (key) => JSON.stringify(previous[key]) !== JSON.stringify(config[key])
          )
          if (adapter?.updateProfile && !connectionChanged) {
            adapter.updateProfile(config)
            await host.syncAccountModel(adapter.id)
            host.emit({ type: 'change' })
            return Response.json({ id: config.id, status: host.statuses.get(config.id) })
          }
          await host.delivery.flush()
          await host.removeAdapter(previous.id)
          await host.addAdapter(kook(config))
          await host.syncAccountModel(config.id)
          return Response.json({ id: config.id, status: host.statuses.get(config.id) })
        }
        if (path === '/api/deliveries')
          return Response.json({
            inbound: host.store.failedInputs().map(({ prompt, message, ...item }) => ({ ...item, text: message.text })),
            outbound: host.store.outputs(),
          })
        if (path === '/api/deliveries/retry' && request.method === 'POST') {
          const data = await body(request)
          const id = text(data.id, '投递 ID')
          if (data.direction === 'inbound') {
            const input = host.store.inbound(id)
            if (!input || input.state !== 'failed') throw new IneffaError('not_retryable', '这条输入无需重试。', 409)
            await host.submitStored(input)
          } else await host.retryOutput(id)
          return Response.json({ ok: true })
        }
        if (path === '/api/deliveries/resolve' && request.method === 'POST') {
          const data = await body(request)
          if (typeof data.received !== 'boolean') throw new IneffaError('invalid_result', '请选择核实后的送达状态。')
          await host.resolveOutput(
            text(data.id, '投递 ID'),
            data.received,
            typeof data.messageId === 'string' ? data.messageId : undefined
          )
          return Response.json({ ok: true })
        }
        if (path.startsWith('/api/')) throw new IneffaError('not_found', '此接口不存在。', 404)
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
        const requested = resolve(dist, `.${decodeURIComponent(path)}`)
        const rel = relative(dist, requested)
        if (rel.startsWith(`..${sep}`) || rel === '..') return new Response(null, { status: 404 })
        const asset = Bun.file(requested)
        const file = path !== '/' && (await asset.exists()) ? asset : Bun.file(resolve(dist, 'index.html'))
        if (!(await file.exists())) return new Response('WebUI 尚未构建，请运行 bun run build。', { status: 503 })
        return new Response(file, {
          headers: {
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
            'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
          },
        })
      } catch (error) {
        const status = error instanceof IneffaError ? error.status : 500
        const code = error instanceof IneffaError ? error.code : ((error as { _tag?: string })?._tag ?? 'service_error')
        return Response.json(
          { error: { code, message: errorMessage(error) } },
          { status, headers: { 'Cache-Control': 'no-store' } }
        )
      } finally {
        releaseConfiguration?.()
      }
    },
  })
  return {
    server,
    async close() {
      for (const close of clients) close()
      await server.stop(true)
    },
  }
}

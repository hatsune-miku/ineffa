import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { slashCommand } from './commands'
import { Delivery } from './delivery'
import { type Backend, type Engine, sourceInputId } from './engine'
import { snapshotFile } from './files'
import { buildHandoff } from './handoff'
import { conversationContext, messageContext } from './message-context'
import { modelReference } from './model'
import type { OpenCodeBridge } from './opencode'
import { Presentation } from './presentation'
import { accountPrompt } from './prompt'
import { Questions } from './questions'
import { Store, identity } from './store'
import {
  type Adapter,
  type AdapterStatus,
  type Address,
  type Binding,
  type HostEvent,
  type Inbound,
  type IncomingMessage,
  IneffaError,
  type Outbound,
  errorMessage,
} from './types'

export class Host {
  readonly engines = new Map<Backend, Engine>()
  readonly adapters = new Map<string, Adapter>()
  readonly statuses = new Map<string, AdapterStatus>()
  readonly delivery: Delivery
  private readonly presentation: Presentation
  private readonly questions: Questions
  private switching = new Set<string>()
  private sessionMutations = new Map<string, number>()
  private identityOwners = new Map<string, string>()
  private listeners = new Set<(event: HostEvent) => void>()
  private submissions = new Map<string, Promise<unknown>>()
  private watchers = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private controller = new AbortController()
  private streams: Promise<void>[] = []
  private readonly promptsReady: Promise<void>
  readonly limits: { maxPending: number }
  constructor(
    readonly store: Store,
    readonly engine: OpenCodeBridge,
    limits: Partial<{ maxPending: number }> = {},
    extraEngines: Engine[] = []
  ) {
    this.limits = { maxPending: limits.maxPending ?? 128 }
    for (const runtime of [engine, ...extraEngines]) {
      if (this.engines.has(runtime.backend))
        throw new IneffaError('duplicate_backend', `后端 ${runtime.backend} 重复注册。`)
      this.engines.set(runtime.backend, runtime)
      runtime.debug.enabled = (sessionId) => {
        const binding = store.bySession(sessionId)
        return Boolean(binding?.debug && !binding.archivedAt && binding.backend === runtime.backend)
      }
    }
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new IneffaError('invalid_limits', '排队上限必须是正整数。')
    this.delivery = new Delivery(
      store,
      (id) => this.adapter(id),
      (output, binding) => this.relay(output, binding),
      (event) => this.emit(event)
    )
    this.presentation = new Presentation(this.delivery)
    this.questions = new Questions(
      store,
      (binding) => this.engineFor(binding),
      (id) => this.adapter(id),
      (id) => this.delivery.enqueue(id)
    )
    this.promptsReady = Promise.all(
      [...this.engines.values()].map((engine) =>
        engine
          .configureFileTool(
            (sessionId) => {
              const binding = this.store.bySession(sessionId)
              return Boolean(
                binding && !binding.archivedAt && this.adapters.get(binding.adapterId)?.capabilities.attachments
              )
            },
            (sessionId, messageId, callId, path, caption) => this.sendFile(sessionId, messageId, callId, path, caption)
          )
          .then(() =>
            engine.configureAccountPrompts((sessionId) => {
              const binding = this.store.bySession(sessionId)
              if (!binding || binding.archivedAt) return
              const adapter = this.adapters.get(binding.adapterId)
              if (!adapter || !this.ownsIdentity(adapter)) return
              return accountPrompt(adapter, this.conversationPeers(adapter, binding.address))
            })
          )
      )
    ).then(() => {})
  }
  engineFor(binding: Binding | string): Engine {
    const current = typeof binding === 'string' ? this.store.bySession(binding) : binding
    if (!current) throw new IneffaError('conversation_not_found', '此会话不存在。', 404)
    const engine = this.engines.get(current.backend)
    if (!engine) throw new IneffaError('backend_unavailable', `后端 ${current.backend} 未加载。`, 503)
    return engine
  }
  private async sendFile(sessionId: string, messageId: string, callId: string, path: string, caption: string) {
    const binding = this.store.bySession(sessionId)
    if (!binding || binding.archivedAt) throw new Error('此工具只能用于当前平台会话。')
    const adapter = this.adapter(binding.adapterId)
    if (!adapter.capabilities.attachments || !adapter.canAccess(binding.address))
      throw new Error('此会话不支持发送附件。')
    if (caption.length > 2_000) throw new Error('附件说明不能超过 2,000 字符。')
    const sourceId = `file:${messageId}:${callId}`
    let output = this.store.output(identity('out_', binding.id, sourceId))
    if (!output) {
      const file = await snapshotFile(binding.directory, path, join(dirname(this.engine.databasePath), 'attachments'))
      const inputId = await this.engineFor(binding).inputForAssistant(sessionId, messageId)
      if (this.store.binding(binding.id).archivedAt) throw new Error('此会话已归档。')
      output = this.store.prepareOutput(binding.id, sourceId, inputId ?? null, caption, {
        kind: 'attachment',
        files: [file],
      })
    }
    await this.delivery.enqueue(output.id)
    const result = this.store.output(output.id)!
    if (result.state === 'sent') return `附件已发送：${result.files?.[0]?.name}。消息 ID：${result.messageId}`
    return `附件投递${result.state === 'unknown' ? '结果未知，请用户核实，勿重复发送' : '失败'}：${result.error}`
  }
  private conversationPeers(adapter: Adapter, address: Address): Adapter[] {
    if (!adapter.canAccess(address)) return []
    const key = adapter.conversationKey?.(address)
    if (!key) return []

    return [...this.adapters.values()]
      .filter(
        (peer) =>
          peer.id !== adapter.id &&
          peer.platform === adapter.platform &&
          peer.identity &&
          this.ownsIdentity(peer) &&
          peer.canAccess(address) &&
          peer.conversationKey?.(address) === key
      )
      .sort((left, right) => left.id.localeCompare(right.id))
  }
  subscribe(listener: (event: HostEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  emit(event: HostEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* One UI subscriber must not interrupt delivery. */
      }
    }
  }
  adapter(id: string): Adapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new IneffaError('adapter_not_found', `账号 ${id} 未加载，请检查配置。`, 404)
    if (!this.ownsIdentity(adapter))
      throw new IneffaError('duplicate_identity', '此平台身份已被另一个账号实例使用。', 409)
    // Gateway input can arrive before start() resolves; claim the verified identity immediately.
    if (adapter.identity) this.identityOwners.set(`${adapter.platform}:${adapter.identity.id}`, id)
    return adapter
  }
  private ownsIdentity(adapter: Adapter) {
    const owner = adapter.identity ? this.identityOwners.get(`${adapter.platform}:${adapter.identity.id}`) : undefined
    return !owner || owner === adapter.id
  }
  async removeAdapter(id: string) {
    const adapter = this.adapters.get(id)
    if (adapter) await adapter.stop()
    this.adapters.delete(id)
    this.statuses.delete(id)
    for (const [key, owner] of this.identityOwners) if (owner === id) this.identityOwners.delete(key)
  }
  async addAdapter(adapter: Adapter) {
    modelReference(adapter.model)
    if (!this.engines.has(adapter.backend ?? 'opencode'))
      throw new IneffaError('backend_unavailable', '所选后端未加载。')
    if (!/^[a-zA-Z0-9_-]+$/.test(adapter.id))
      throw new IneffaError('invalid_adapter_id', '账号 ID 只能包含英文字母、数字、下划线和连字符。')
    if (this.adapters.has(adapter.id)) throw new IneffaError('duplicate_adapter', `账号 ID ${adapter.id} 已存在。`, 409)
    this.adapters.set(adapter.id, adapter)
    await this.connect(adapter.id)
  }
  async syncAccountModel(adapterId: string) {
    const model = modelReference(this.adapter(adapterId).model)
    if (!model) return
    for (const binding of this.store.bindings().filter((item) => item.adapterId === adapterId)) {
      await this.serial(binding.id, async () => {
        const current = this.store.current(adapterId, binding.address.id)
        if (!current) return
        await this.ensure(current)
        this.emit({ type: 'change', bindingId: current.id })
      })
    }
  }
  async connect(id: string) {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new IneffaError('adapter_not_found', '账号不存在。', 404)
    this.statuses.set(id, { state: 'connecting' })
    this.emit({ type: 'change' })
    try {
      await adapter.start({
        receive: async (message) => {
          try {
            await this.receive(id, message)
          } catch (error) {
            const binding = this.store.current(id, message.address.id)
            this.emit({ type: 'error', bindingId: binding?.id, message: errorMessage(error) })
            if (binding) {
              const notice = this.store.prepareOutput(
                binding.id,
                `input-error:${message.id}`,
                null,
                errorMessage(error),
                { kind: 'notice' }
              )
              void this.delivery.enqueue(notice.id)
            }
          }
        },
        status: (status) => {
          this.statuses.set(id, status)
          this.emit({ type: 'change' })
        },
        echo: (nonce, messageId) => this.delivery.confirm(id, nonce, messageId),
      })
      if (!this.ownsIdentity(adapter)) {
        await adapter.stop()
        throw new IneffaError('duplicate_identity', '此平台身份已被另一个账号实例使用，请更换账号或 Token。', 409)
      }
      if (adapter.identity) this.identityOwners.set(`${adapter.platform}:${adapter.identity.id}`, id)
      this.statuses.set(id, { state: 'connected' })
    } catch (error) {
      this.statuses.set(id, { state: 'error', error: errorMessage(error) })
    }
    this.emit({ type: 'change' })
  }
  async start() {
    await this.promptsReady
    this.streams = [...this.engines.values()].map((engine) => this.readLive(engine))
    for (const binding of this.store.bindings()) {
      if (!this.adapters.has(binding.adapterId)) continue
      try {
        await this.ensure(binding)
        await this.questions.recover(this.store.binding(binding.id))
      } catch (error) {
        this.emit({ type: 'error', bindingId: binding.id, message: errorMessage(error) })
      }
    }
    for (const input of this.store.pendingInputs()) {
      void this.submitStored(input).catch((error) =>
        this.emit({ type: 'error', bindingId: input.bindingId, message: errorMessage(error) })
      )
    }
    for (const output of this.store.outputs(true))
      if (this.adapters.has(this.store.binding(output.bindingId).adapterId)) void this.delivery.enqueue(output.id)
  }
  private async ensure(binding: Binding) {
    await this.promptsReady
    const engine = this.engineFor(binding)
    const adapter = this.adapters.get(binding.adapterId)
    const selected = (adapter?.backend ?? 'opencode') === binding.backend ? adapter?.model : undefined
    const info = await engine.ensure(binding, selected ?? (!binding.engineReady ? binding.model : undefined))
    const model = modelReference(selected)
    if (model && (info.model?.providerID !== model.providerID || info.model.id !== model.id))
      await engine.switchModel(binding.sessionId, model)
    this.store.ready(binding.id)
    if (!this.watchers.has(binding.id)) {
      const controller = new AbortController()
      this.watchers.set(binding.id, {
        controller,
        promise: this.readSession(binding.id, AbortSignal.any([controller.signal, this.controller.signal])),
      })
    }
  }
  async createConversation(
    adapterId: string,
    address: Address,
    agent?: string,
    backend?: Backend,
    model?: string
  ): Promise<Binding> {
    const adapter = this.adapter(adapterId)
    if (!adapter.canAccess(address)) throw new IneffaError('conversation_forbidden', '当前账号不允许访问此会话。', 403)
    const selected = backend ?? adapter.backend ?? 'opencode'
    if (!this.engines.has(selected)) throw new IneffaError('backend_unavailable', '所选后端未加载。')
    modelReference(model)
    const binding = this.store.ensure(
      adapterId,
      address,
      agent ?? adapter.agent,
      resolve(adapter.directory),
      selected,
      model ?? (selected === (adapter.backend ?? 'opencode') ? adapter.model : undefined)
    )
    await this.ensure(binding)
    this.emit({ type: 'change', bindingId: binding.id })
    return this.store.binding(binding.id)
  }
  async receive(
    adapterId: string,
    message: IncomingMessage,
    source?: { rootId: string }
  ): Promise<Inbound | undefined> {
    const adapter = this.adapter(adapterId)
    if (!adapter.canAccess(message.address)) return
    if (message.author.id === adapter.identity?.id) return
    // Managed bot messages enter through confirmed final delivery, never through streaming gateway echoes.
    if (
      !source &&
      message.author.bot &&
      (message.address.kind !== 'channel' ||
        [...this.adapters.values()].some(
          (peer) => peer.platform === adapter.platform && peer.identity?.id === message.author.id
        ))
    )
      return
    const id = identity('msg_', adapterId, message.address.id, message.id)
    const existing = this.store.inbound(id)
    if (existing) return existing
    const command = slashCommand(adapter, { ...message, author: { ...message.author, bot: false } })
    if (message.text.length > 100_000)
      throw new IneffaError('message_too_large', '消息超过 100,000 字符，请拆分后发送。', 413)
    if (!command && (await this.questions.receive(adapterId, message))) {
      this.emit({ type: 'change' })
      return
    }
    const wake =
      (!message.author.bot || Boolean(source)) &&
      (message.address.kind === 'direct' ||
        message.mentions.includes(adapter.identity?.id ?? '') ||
        Boolean(command && this.questions.expects(adapterId, message)))
    if (command && (!wake || message.author.bot)) return
    if (!message.text.trim() && !message.files?.length) return
    let binding = this.store.ensure(
      adapterId,
      message.address,
      adapter.agent,
      resolve(adapter.directory),
      adapter.backend ?? 'opencode',
      adapter.model
    )
    return this.serial(binding.id, async () => {
      const duplicate = this.store.inbound(id)
      if (duplicate) return duplicate
      if (source) {
        const root = this.store.inbound(source.rootId)
        if (
          !root ||
          !this.store.continues(root.bindingId) ||
          this.store.hasResetSince(adapterId, message.address.id, root.createdAt)
        )
          return
      }
      // A reset queued ahead of this input may have replaced the binding.
      binding = this.store.ensure(
        adapterId,
        message.address,
        adapter.agent,
        resolve(adapter.directory),
        adapter.backend ?? 'opencode',
        adapter.model
      )
      if (wake || !binding.engineReady) await this.ensure(this.store.binding(binding.id))
      if (command && !['new', 'abort', 'help', 'debug'].includes(command.name))
        throw new IneffaError('command_not_found', `不支持 /${command.name}，输入 /help 查看本地命令。`)
      if (command && ['new', 'abort', 'help'].includes(command.name) && (command.arguments || message.files?.length))
        throw new IneffaError('command_arguments', `/${command.name} 不接受参数或附件。`)
      if (command?.name === 'debug' && (!['on', 'off'].includes(command.arguments) || message.files?.length))
        throw new IneffaError('command_arguments', '用法：/debug on 或 /debug off。')
      if (
        wake &&
        !command &&
        (await this.engineFor(binding).pending(binding.sessionId)).length >= this.limits.maxPending
      )
        throw new IneffaError('inbox_full', `此会话已有 ${this.limits.maxPending} 条排队输入，请等待或清理队列。`, 429)
      const quote =
        message.quote &&
        !slashCommand(adapter, {
          ...message,
          text: message.quote,
          mentions: adapter.mentions(message.quote),
          author: { ...message.author, bot: false },
        })
          ? this.store.contextQuote(message.quote, message.quoteId)
          : ''
      const context = wake && !command ? this.store.observed(binding.id) : []
      context.sort((left, right) => left.message.createdAt - right.message.createdAt)
      const current = messageContext(message, quote)
      const sender =
        source && wake
          ? this.conversationPeers(adapter, message.address).find((peer) => peer.identity?.id === message.author.id)
          : undefined
      const prompt = wake
        ? conversationContext(
            message,
            current,
            context.map((item) => item.prompt),
            sender?.identity ? adapter.mention(sender.identity) : undefined
          )
        : current
      const input: Inbound = {
        id,
        bindingId: binding.id,
        message,
        prompt: command ? '' : prompt,
        command,
        rootId: source?.rootId ?? id,
        state: wake ? 'pending' : 'observed',
        error: null,
        createdAt: Date.now(),
      }
      if (command?.name === 'new') {
        await this.resetBinding(binding.id, input)
        return this.store.inbound(id)!
      }
      const saved = this.store.admit(input, context)
      if (saved.fresh && wake) await this.submit(saved.item)
      else if (saved.fresh) this.emit({ type: 'change', bindingId: binding.id })
      return this.store.inbound(id)!
    })
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const binding = this.store.binding(id)
    const key = identity('lane_', binding.adapterId, binding.address.id)
    const next = (this.submissions.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.submissions.set(key, next)
    void next
      .finally(() => {
        if (this.submissions.get(key) === next) this.submissions.delete(key)
      })
      .catch(() => {})
    return next
  }
  async submitStored(input: Inbound) {
    return this.serial(input.bindingId, () => this.submit(input))
  }
  private async submit(input: Inbound) {
    const state = this.store.inbound(input.id)?.state
    if (state === 'admitted' || state === 'cancelled' || state === 'observed') return
    if (state === 'unknown')
      throw new IneffaError('command_uncertain', '此命令可能已经执行，请核实结果；确认需要后以新消息重新发送。', 409)
    const binding = this.store.binding(input.bindingId)
    if (binding.archivedAt) {
      this.store.inboundState(input.id, 'cancelled')
      return
    }
    try {
      await this.ensure(binding)
      if (input.command?.name === 'new') {
        const previousBinding = this.store.bySession(input.command.previousSessionId!)
        if (previousBinding?.backend === binding.backend && !this.adapters.get(binding.adapterId)?.model) {
          const previous = await this.engineFor(previousBinding).getSession(previousBinding.sessionId)
          if (previous.model) await this.engineFor(binding).switchModel(binding.sessionId, previous.model)
        }
        this.commandNotice(input, '已开启新会话，旧会话已归档。')
      } else if (input.command?.name === 'abort') {
        await this.stopBinding(binding.id)
        this.commandNotice(input, '已停止。')
      } else if (input.command?.name === 'debug') {
        const enabled = input.command.arguments === 'on'
        this.store.setDebug(binding.id, enabled)
        if (!enabled) this.engineFor(binding).debug.clear(binding.sessionId)
        this.commandNotice(input, enabled ? 'Debug on' : 'Debug off')
      } else if (input.command?.name === 'help') {
        this.commandNotice(
          input,
          [
            '/new — 开启新会话，保留旧历史',
            '/abort — 停止当前输出并清空队列',
            '/help — 查看命令',
            '/debug on|off — 开关回复耗时统计',
          ].join('\n')
        )
      } else {
        if (input.command) {
          throw new IneffaError('command_not_found', `不支持 /${input.command.name}。`)
        }
        const adapter = this.adapter(binding.adapterId)
        if (input.message.mode === 'steer' && !this.engineFor(binding).capabilities.steer)
          throw new IneffaError('unsupported_operation', '此后端暂不支持插入当前执行，请使用排队发送。')
        const files = [...this.store.contextFiles(input.id), ...(input.message.files ?? [])]
        await this.engineFor(binding).submit(
          binding,
          input,
          adapter.prepareAttachments ? await adapter.prepareAttachments(files) : files
        )
      }
      this.store.inboundState(input.id, 'admitted')
    } catch (error) {
      const state = this.store.inbound(input.id)?.state === 'unknown' ? 'unknown' : 'failed'
      this.store.inboundState(input.id, state, errorMessage(error))
      throw error
    } finally {
      this.emit({ type: 'change', bindingId: binding.id })
    }
  }
  private commandNotice(input: Inbound, text: string) {
    const notice = this.store.prepareOutput(input.bindingId, `command:${input.id}`, null, text, { kind: 'notice' })
    void this.delivery.enqueue(notice.id)
  }
  private async readSession(id: string, signal: AbortSignal) {
    let backoff = 250
    // Rebuild transient counters from the backend journal; never resend past replies.
    let cursor = 0
    const journalInputs = new Set<string>()
    const engine = this.engineFor(this.store.binding(id))
    while (!signal.aborted) {
      try {
        for await (const event of engine.log({ ...this.store.binding(id), cursor }, signal)) {
          if (!('durable' in event) || !event.durable) continue
          const binding = this.store.binding(id)
          let deliveredInputId: string | undefined
          if (event.type === 'session.inbox.delivered') {
            deliveredInputId = event.data.inboxID
            if (!this.store.inbound(deliveredInputId)) {
              const message = await engine.message(binding.sessionId, deliveredInputId).catch((error) => {
                if (
                  (error as { _tag?: string })?._tag === 'MessageNotFoundError' ||
                  (error instanceof IneffaError && error.code === 'message_not_found')
                )
                  return
                throw error
              })
              if (message) deliveredInputId = sourceInputId(message)
            }
            if (this.store.inbound(deliveredInputId)?.bindingId === id) journalInputs.add(deliveredInputId)
          }
          if (
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          ) {
            this.store.settleInputs(id, journalInputs)
            journalInputs.clear()
          }
          this.presentation.observe(binding, event, event.durable.seq <= binding.cursor)
          const replay = event.durable.seq <= binding.cursor
          if (replay && event.type !== 'session.step.ended' && event.type !== 'session.step.failed') {
            cursor = event.durable.seq
            continue
          }
          const inputId = deliveredInputId
          if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
            if (!replay) engine.debug.usage(event)
            const message = await engine.message(binding.sessionId, event.data.assistantMessageID)
            if (message.type === 'assistant') {
              const text = message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n\n')
              const publicText = text + (message.error ? `\n\n本轮处理失败：${message.error.message}` : '')
              const complete = event.type === 'session.step.failed' || event.data.finish !== 'tool-calls'
              if (complete && binding.debug && !replay) {
                const report = engine.debug.report(binding.sessionId, event.created)
                this.store.saveDebugReport(id, message.id, report)
                this.store.saveDebugReport(id, this.presentation.sourceId(binding, message.id), report)
              }
              this.presentation.step(binding, message.id, publicText, complete, replay, Boolean(message.error))
              if (complete && !replay) engine.debug.finish(binding.sessionId, event.created)
            }
          }
          if (replay) {
            cursor = event.durable.seq
            continue
          }
          this.store.checkpoint(id, event.durable.seq, inputId)
          cursor = event.durable.seq
          this.emit({ type: 'change', bindingId: id })
          backoff = 250
        }
      } catch (error) {
        if (signal.aborted) break
        this.emit({ type: 'error', bindingId: id, message: `读取对话事件失败：${errorMessage(error)}` })
      }
      await delay(backoff, undefined, { signal }).catch(() => {})
      backoff = Math.min(backoff * 2, 15_000)
    }
  }
  private async readLive(engine: Engine) {
    let backoff = 250
    while (!this.controller.signal.aborted) {
      try {
        for await (const event of engine.events(this.controller.signal)) {
          backoff = 250
          if (event.type === 'session.text.delta') {
            const binding = this.store.bySession(event.data.sessionID)
            if (binding && !binding.archivedAt) this.presentation.delta(binding, event)
            if (binding)
              this.emit({
                type: 'delta',
                bindingId: binding.id,
                messageId: event.data.assistantMessageID,
                ordinal: event.data.ordinal,
                text: event.data.delta,
              })
          } else if (event.type === 'form.created') {
            const binding = this.store.bySession(event.data.form.sessionID)
            if (binding && !binding.archivedAt) await this.questions.created(binding, event.data.form)
            this.emit({ type: 'change', bindingId: binding?.id })
          } else if (event.type === 'form.replied' || event.type === 'form.cancelled') {
            this.questions.closed(event.data.id)
            this.emit({ type: 'change' })
          } else if (event.type === 'permission.asked') {
            const binding = this.store.bySession(event.data.sessionID)
            if (binding && !binding.archivedAt && this.adapter(binding.adapterId).platform !== 'web') {
              this.questions.notice(
                binding,
                `permission:${event.data.id}`,
                `需要权限确认：${event.data.action}\n请在 WebUI 中允许或拒绝。`
              )
            }
            this.emit({ type: 'change', bindingId: binding?.id })
          } else if (event.type === 'session.status' || event.type === 'server.connected') {
            this.emit({ type: 'change' })
          }
        }
      } catch (error) {
        if (!this.controller.signal.aborted)
          this.emit({ type: 'error', message: `实时连接中断，正在重连：${errorMessage(error)}` })
      }
      await delay(backoff, undefined, { signal: this.controller.signal }).catch(() => {})
      if (!this.controller.signal.aborted) {
        for (const binding of this.store.bindings()) {
          if (this.adapters.has(binding.adapterId) && binding.backend === engine.backend)
            await this.questions
              .recover(binding)
              .catch((error) => this.emit({ type: 'error', bindingId: binding.id, message: errorMessage(error) }))
        }
      }
      backoff = Math.min(backoff * 2, 15_000)
    }
  }
  private async relay(output: Outbound, binding: Binding) {
    const adapter = this.adapter(binding.adapterId)
    const parent = output.inputId ? this.store.inbound(output.inputId) : undefined
    const root = parent ? this.store.inbound(parent.rootId) : undefined
    if (!root || !adapter.identity || !output.messageId || binding.archivedAt || !this.store.continues(root.bindingId))
      return
    const mentions = adapter.mentions(output.text)
    for (const peer of this.conversationPeers(adapter, binding.address)) {
      if (this.store.hasResetSince(peer.id, binding.address.id, root.createdAt)) continue
      await this.receive(
        peer.id,
        {
          id: output.messageId,
          address: binding.address,
          author: { id: adapter.identity.id, name: adapter.name, bot: true },
          text: output.text,
          files: output.files,
          mentions,
          createdAt: output.createdAt,
          quote: parent?.message.text,
          quoteId: parent?.message.id,
          quoteAuthor: parent?.message.author,
        },
        { rootId: root.id }
      )
    }
  }
  async stop(bindingId: string, cancelQueued = true) {
    await this.serial(bindingId, () => this.stopBinding(bindingId, cancelQueued))
    this.emit({ type: 'change', bindingId })
  }
  private async stopBinding(bindingId: string, cancelQueued = true) {
    const b = this.store.binding(bindingId)
    const engine = this.engineFor(b)
    const queued = cancelQueued ? await engine.pending(b.sessionId) : []
    await engine.stop(b.sessionId, cancelQueued)
    this.questions.closeBinding(bindingId)
    this.presentation.interrupt(b)
    engine.debug.clear(b.sessionId)
    for (const item of queued) if (this.store.inbound(item.id)) this.store.inboundState(item.id, 'cancelled')
  }
  private async stopWatching(bindingId: string) {
    const watcher = this.watchers.get(bindingId)
    if (!watcher) return
    watcher.controller.abort()
    await watcher.promise
    this.watchers.delete(bindingId)
  }
  async archive(bindingId: string) {
    await this.serial(bindingId, async () => {
      await this.stopBinding(bindingId)
      this.store.archive(bindingId)
      this.questions.closeBinding(bindingId)
      await this.stopWatching(bindingId)
      this.presentation.clear(this.store.binding(bindingId))
      await this.engineFor(this.store.binding(bindingId)).releaseSession?.(this.store.binding(bindingId).sessionId)
    })
    this.emit({ type: 'change', bindingId })
  }
  async removeConversation(bindingId: string) {
    await this.serial(bindingId, async () => {
      const binding = this.store.binding(bindingId)
      this.store.archive(bindingId)
      await this.stopWatching(bindingId)
      this.presentation.clear(binding)
      // The backend stops execution and removes its native session history.
      try {
        await this.engineFor(binding).removeSession(binding.sessionId)
      } catch (error) {
        // A previous attempt may have removed the native session before the local transaction committed.
        if (
          (error as { _tag?: string })?._tag !== 'SessionNotFoundError' &&
          !(error instanceof IneffaError && error.code === 'session_not_found')
        )
          throw error
      }
      this.store.remove(bindingId)
    })
    this.emit({ type: 'change', bindingId })
  }
  assertSessionMutable(bindingId: string) {
    if (this.switching.has(bindingId)) throw new IneffaError('session_switching', '会话正在切换后端。', 409)
  }
  beginSessionMutation(bindingId: string): () => void {
    this.assertSessionMutable(bindingId)
    this.sessionMutations.set(bindingId, (this.sessionMutations.get(bindingId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.sessionMutations.get(bindingId) ?? 1) - 1
      if (remaining) this.sessionMutations.set(bindingId, remaining)
      else this.sessionMutations.delete(bindingId)
    }
  }
  async cancelPending(bindingId: string, inputId: string) {
    return this.serial(bindingId, async () => {
      const binding = this.store.binding(bindingId)
      if (binding.archivedAt) throw new IneffaError('archived', '此会话已归档。', 409)
      const engine = this.engineFor(binding)
      const transfer = this.store.handoff(bindingId)
      if (
        transfer?.inputId === inputId &&
        (await engine.pending(binding.sessionId)).some((item) => item.id !== inputId)
      )
        throw new IneffaError(
          'handoff_input_pending',
          '此输入携带交接记录，请使用 /abort 一并清空队列后重新发送。',
          409
        )
      await engine.cancelPending(binding.sessionId, inputId)
      if (this.store.inbound(inputId)) this.store.inboundState(inputId, 'cancelled')
      this.emit({ type: 'change', bindingId })
    })
  }
  private async assertHandoffIdle(binding: Binding, target: Engine) {
    const engine = this.engineFor(binding)
    const [active, pending, forms, session, permissions] = await Promise.all([
      engine.active(),
      engine.pending(binding.sessionId),
      engine.listForms(binding.sessionId),
      engine.getSession(binding.sessionId),
      engine.capabilities.permissions ? this.engine.native.permission.list({ sessionID: binding.sessionId }) : [],
    ])
    if (active[binding.sessionId] || pending.length || forms.length || permissions.length)
      throw new IneffaError('session_busy', '请等待当前执行、排队输入和待回答问题结束后切换。', 409)
    if (
      !target.capabilities.permissions &&
      session.permissions?.some((rule) => rule.effect !== 'allow' || rule.action !== '*' || rule.resource !== '*')
    )
      throw new IneffaError('handoff_permissions', '目标后端不支持当前会话的权限规则，请先处理这些规则。', 409)
    this.store.assertHandoffReady(binding.id)
    return session
  }
  async switchBackend(bindingId: string, backend: Backend, model?: string): Promise<Binding> {
    return this.serial(bindingId, async () => {
      const previous = this.store.binding(bindingId)
      if (previous.archivedAt) {
        const next = this.store.successor(bindingId)
        if (next?.backend === backend && (!model || !next.model || model === next.model)) {
          if (!next.archivedAt) await this.ensure(next)
          return next
        }
        throw new IneffaError('archived', '此会话已归档，请选择当前会话。', 409)
      }
      if (previous.backend === backend) throw new IneffaError('same_backend', '此会话已使用所选后端。')
      const target = this.engines.get(backend)
      if (!target) throw new IneffaError('backend_unavailable', '所选后端未加载。')
      const adapter = this.adapter(previous.adapterId)
      const bound = (adapter.backend ?? 'opencode') === backend ? adapter.model : undefined
      if (bound && model && bound !== model)
        throw new IneffaError('account_model_bound', '所选后端使用账号绑定的模型。', 409)
      const selected = bound ?? model
      modelReference(selected)
      if (backend === 'pi' && !selected) throw new IneffaError('missing_model', '请选择 Pi 使用的模型。')
      if (this.sessionMutations.has(bindingId))
        throw new IneffaError('session_busy', '会话设置正在更新，请稍后切换。', 409)
      this.switching.add(bindingId)
      const id = randomUUID()
      const now = Date.now()
      const next: Binding = {
        ...previous,
        id,
        backend,
        model: selected,
        predecessorId: previous.id,
        sessionId: `ses_${id.replaceAll('-', '')}`,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        engineReady: 0,
        cursor: 0,
        inputId: null,
        agent: backend === 'opencode' ? adapter.agent : 'build',
      }
      let prepared = false
      let committed = false
      try {
        await this.promptsReady
        await this.assertHandoffIdle(previous, target)
        const transfer = await buildHandoff(
          previous,
          this.engineFor(previous),
          this.store,
          `${adapter.name} · ${adapter.identity?.id ?? adapter.id} · Bot`
        )
        prepared = true
        await target.ensure(next, selected)
        await this.assertHandoffIdle(previous, target)
        const result = this.store.commitHandoff(previous.id, next, transfer)
        committed = true
        await this.stopWatching(previous.id)
        this.presentation.clear(previous)
        await this.ensure(result)
        try {
          await this.engineFor(previous).releaseSession?.(previous.sessionId)
        } catch (error) {
          this.emit({ type: 'error', bindingId: previous.id, message: errorMessage(error) })
        }
        this.emit({ type: 'change', bindingId: result.id })
        return this.store.binding(result.id)
      } catch (error) {
        if (prepared && !committed) await target.removeSession(next.sessionId).catch(() => {})
        throw error
      } finally {
        this.switching.delete(bindingId)
      }
    })
  }
  async reset(bindingId: string) {
    return this.serial(bindingId, () => this.resetBinding(bindingId))
  }
  private async resetBinding(bindingId: string, input?: Inbound) {
    const previous = this.store.binding(bindingId)
    const adapter = this.adapter(previous.adapterId)
    const backend = adapter.platform === 'web' ? previous.backend : (adapter.backend ?? 'opencode')
    if (!this.engines.has(backend)) throw new IneffaError('backend_unavailable', '所选后端未加载。')
    const info = await this.engineFor(previous).getSession(previous.sessionId)
    await this.stopBinding(bindingId)
    await this.stopWatching(bindingId)
    this.presentation.clear(previous)
    if (input?.command) input.command.previousSessionId = previous.sessionId
    const inherited =
      backend === previous.backend && info.model ? `${info.model.providerID}/${info.model.id}` : undefined
    const model = adapter.model ?? inherited
    const next = this.store.replace(
      {
        ...previous,
        backend,
        model,
        agent: backend === previous.backend ? (info.agent ?? previous.agent) : adapter.agent,
      },
      input
    )
    if (input) await this.submit(this.store.inbound(input.id)!)
    else {
      await this.ensure(next)
      if (info.model && backend === previous.backend && !adapter.model)
        await this.engineFor(next).switchModel(next.sessionId, info.model)
    }
    await this.engineFor(previous).releaseSession?.(previous.sessionId)
    this.emit({ type: 'change', bindingId: next.id })
    return this.store.binding(next.id)
  }
  async retryOutput(id: string) {
    const output = this.store.output(id)
    if (!output) throw new IneffaError('delivery_not_found', '找不到这条投递记录。', 404)
    if (output.state === 'sent' && !output.relayed) {
      await this.delivery.enqueue(id)
      return
    }
    if (output.state !== 'failed')
      throw new IneffaError('unsafe_retry', '只有明确失败的发送才能直接重试；结果未知的发送需要先核实。', 409)
    if (output.attempts >= 3)
      throw new IneffaError('retry_limit', '此发送已尝试三次，请检查平台连接与权限后重新发送。', 409)
    this.store.outputState(id, 'pending')
    await this.delivery.enqueue(id)
  }
  async resolveOutput(id: string, received: boolean, messageId?: string) {
    const output = this.store.output(id)
    if (!output || output.state !== 'unknown') throw new IneffaError('not_uncertain', '这条投递无需人工核实。', 409)
    if (received) {
      if (!messageId?.trim()) throw new IneffaError('missing_message_id', '请填写在平台核实的消息 ID。')
      this.store.outputState(id, 'sent', null, messageId.trim())
      await this.delivery.enqueue(id)
    } else this.store.outputState(id, 'failed', '用户已在平台核实未送达，可手动重试。')
    this.emit({ type: 'change', bindingId: output.bindingId })
  }
  async close() {
    this.controller.abort()
    await Promise.allSettled([
      ...this.streams,
      ...[...this.watchers.values()].map((watcher) => watcher.promise),
      ...this.submissions.values(),
    ])
    await this.questions.flush()
    await this.delivery.flush()
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.stop()))
    await Promise.all([...this.engines.values()].map((engine) => engine.close()))
    this.store.close()
  }
}

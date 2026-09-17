import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { slashCommand } from './commands'
import { Delivery } from './delivery'
import { conversationContext, messageContext } from './message-context'
import { modelReference } from './model'
import { type OpenCodeBridge, sourceInputId } from './opencode'
import { Presentation } from './presentation'
import { accountPrompt } from './prompt'
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
  readonly adapters = new Map<string, Adapter>()
  readonly statuses = new Map<string, AdapterStatus>()
  readonly delivery: Delivery
  private readonly presentation: Presentation
  private identityOwners = new Map<string, string>()
  private listeners = new Set<(event: HostEvent) => void>()
  private submissions = new Map<string, Promise<unknown>>()
  private watchers = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private controller = new AbortController()
  private stream?: Promise<void>
  private readonly promptsReady: Promise<void>
  readonly limits: { maxBotTurns: number; maxPending: number }
  constructor(
    readonly store: Store,
    readonly engine: OpenCodeBridge,
    limits: Partial<{ maxBotTurns: number; maxPending: number }> = {}
  ) {
    this.limits = { maxBotTurns: 12, maxPending: 128, ...limits }
    engine.debug.enabled = (sessionId) => {
      const binding = store.bySession(sessionId)
      return Boolean(binding?.debug && !binding.archivedAt)
    }
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new IneffaError('invalid_limits', '协作与排队上限必须是正整数。')
    this.delivery = new Delivery(
      store,
      (id) => this.adapter(id),
      (output, binding) => this.relay(output, binding),
      (event) => this.emit(event)
    )
    this.presentation = new Presentation(this.delivery)
    this.promptsReady = engine.configureAccountPrompts((sessionId) => {
      const binding = this.store.bySession(sessionId)
      if (!binding || binding.archivedAt) return
      const adapter = this.adapters.get(binding.adapterId)
      if (!adapter || !this.ownsIdentity(adapter)) return
      return accountPrompt(adapter, this.conversationPeers(adapter, binding.address))
    })
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
    this.stream = this.readLive()
    for (const binding of this.store.bindings()) {
      if (!this.adapters.has(binding.adapterId)) continue
      try {
        await this.ensure(binding)
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
    const selected = this.adapters.get(binding.adapterId)?.model
    const info = await this.engine.ensure(binding, selected)
    const model = modelReference(selected)
    if (model && (info.model?.providerID !== model.providerID || info.model.id !== model.id))
      await this.engine.native.sessions.switchModel({ sessionID: binding.sessionId, model })
    this.store.ready(binding.id)
    if (!this.watchers.has(binding.id)) {
      const controller = new AbortController()
      this.watchers.set(binding.id, {
        controller,
        promise: this.readSession(binding.id, AbortSignal.any([controller.signal, this.controller.signal])),
      })
    }
  }
  async createConversation(adapterId: string, address: Address, agent?: string): Promise<Binding> {
    const adapter = this.adapter(adapterId)
    if (!adapter.canAccess(address)) throw new IneffaError('conversation_forbidden', '当前账号不允许访问此会话。', 403)
    const binding = this.store.ensure(adapterId, address, agent ?? adapter.agent, resolve(adapter.directory))
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
    const wake =
      (!message.author.bot || Boolean(source)) &&
      (message.address.kind === 'direct' || message.mentions.includes(adapter.identity?.id ?? ''))
    const command = slashCommand(adapter, { ...message, author: { ...message.author, bot: false } })
    if (command && (!wake || message.author.bot)) return
    if (!message.text.trim() && !message.files?.length) return
    if (message.text.length > 100_000)
      throw new IneffaError('message_too_large', '消息超过 100,000 字符，请拆分后发送。', 413)
    let binding = this.store.ensure(adapterId, message.address, adapter.agent, resolve(adapter.directory))
    const id = identity('msg_', adapterId, message.address.id, message.id)
    const existing = this.store.inbound(id)
    if (existing) return existing
    return this.serial(binding.id, async () => {
      const duplicate = this.store.inbound(id)
      if (duplicate) return duplicate
      if (source) {
        const root = this.store.inbound(source.rootId)
        if (
          !root ||
          this.store.binding(root.bindingId).archivedAt ||
          this.store.hasResetSince(adapterId, message.address.id, root.createdAt)
        )
          return
      }
      // A reset queued ahead of this input may have replaced the binding.
      binding = this.store.ensure(adapterId, message.address, adapter.agent, resolve(adapter.directory))
      if (wake || !binding.engineReady) await this.ensure(this.store.binding(binding.id))
      if (command && !['new', 'abort', 'help', 'debug'].includes(command.name))
        throw new IneffaError('command_not_found', `不支持 /${command.name}，输入 /help 查看本地命令。`)
      if (command && ['new', 'abort', 'help'].includes(command.name) && (command.arguments || message.files?.length))
        throw new IneffaError('command_arguments', `/${command.name} 不接受参数或附件。`)
      if (command?.name === 'debug' && (!['on', 'off'].includes(command.arguments) || message.files?.length))
        throw new IneffaError('command_arguments', '用法：/debug on 或 /debug off。')
      if (wake && !command && (await this.engine.pending(binding.sessionId)).length >= this.limits.maxPending)
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
      const prompt = wake
        ? conversationContext(
            message,
            current,
            context.map((item) => item.prompt)
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
      const saved = this.store.admit(input, this.limits.maxBotTurns, context)
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
        const previous = await this.engine.native.sessions.get({ sessionID: input.command.previousSessionId! })
        if (previous.model && !this.adapters.get(binding.adapterId)?.model)
          await this.engine.native.sessions.switchModel({ sessionID: binding.sessionId, model: previous.model })
        this.commandNotice(input, '已开启新会话，旧会话已归档。')
      } else if (input.command?.name === 'abort') {
        await this.stopBinding(binding.id)
        this.commandNotice(input, '已停止。')
      } else if (input.command?.name === 'debug') {
        const enabled = input.command.arguments === 'on'
        this.store.setDebug(binding.id, enabled)
        if (!enabled) this.engine.debug.clear(binding.sessionId)
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
        await this.engine.submit(binding, input, this.store.contextFiles(input.id))
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
    // Rebuild transient counters from OpenCode's journal after a restart; never resend past replies.
    let cursor = 0
    while (!signal.aborted) {
      try {
        for await (const event of this.engine.log({ ...this.store.binding(id), cursor }, signal)) {
          if (!('durable' in event) || !event.durable) continue
          const binding = this.store.binding(id)
          this.presentation.observe(binding, event, event.durable.seq <= binding.cursor)
          if (event.durable.seq <= binding.cursor) {
            cursor = event.durable.seq
            continue
          }
          let inputId: string | undefined
          if (event.type === 'session.inbox.delivered') {
            inputId = event.data.inboxID
            if (!this.store.inbound(inputId)) {
              const message = await this.engine.message(binding.sessionId, inputId).catch((error) => {
                // Control inbox entries do not necessarily create a message. Other errors must replay the event.
                if ((error as { _tag?: string })?._tag === 'MessageNotFoundError') return
                throw error
              })
              if (message) inputId = sourceInputId(message)
            }
          }
          if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
            this.engine.debug.usage(event)
            const message = await this.engine.message(binding.sessionId, event.data.assistantMessageID)
            if (message.type === 'assistant') {
              const text = message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n\n')
              const publicText = text + (message.error ? `\n\n本轮处理失败：${message.error.message}` : '')
              if (publicText.trim()) {
                if (binding.debug)
                  this.store.saveDebugReport(id, message.id, this.engine.debug.report(binding.sessionId, event.created))
                this.delivery.publish(
                  binding,
                  message.id,
                  message.error ? null : binding.inputId,
                  publicText,
                  'reply',
                  true
                )
              }
              if (event.type === 'session.step.failed' || event.data.finish !== 'tool-calls')
                this.engine.debug.finish(binding.sessionId, event.created)
            }
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
  private async readLive() {
    let backoff = 250
    while (!this.controller.signal.aborted) {
      try {
        for await (const event of this.engine.events(this.controller.signal)) {
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
          } else if (
            event.type === 'permission.asked' ||
            event.type === 'form.created' ||
            event.type === 'session.status' ||
            event.type === 'server.connected'
          ) {
            this.emit({ type: 'change' })
          }
        }
      } catch (error) {
        if (!this.controller.signal.aborted)
          this.emit({ type: 'error', message: `实时连接中断，正在重连：${errorMessage(error)}` })
      }
      await delay(backoff, undefined, { signal: this.controller.signal }).catch(() => {})
      backoff = Math.min(backoff * 2, 15_000)
    }
  }
  private async relay(output: Outbound, binding: Binding) {
    const adapter = this.adapter(binding.adapterId)
    const parent = output.inputId ? this.store.inbound(output.inputId) : undefined
    const root = parent ? this.store.inbound(parent.rootId) : undefined
    if (
      !root ||
      !adapter.identity ||
      !output.messageId ||
      binding.archivedAt ||
      this.store.binding(root.bindingId).archivedAt
    )
      return
    const mentions = adapter.mentions(output.text)
    for (const peer of this.conversationPeers(adapter, binding.address)) {
      if (this.store.hasResetSince(peer.id, binding.address.id, root.createdAt)) continue
      try {
        await this.receive(
          peer.id,
          {
            id: output.messageId,
            address: binding.address,
            author: { id: adapter.identity.id, name: adapter.name, bot: true },
            text: output.text,
            mentions,
            createdAt: output.createdAt,
            quote: parent?.message.text,
            quoteId: parent?.message.id,
            quoteAuthor: parent?.message.author,
          },
          { rootId: root.id }
        )
      } catch (error) {
        if (error instanceof IneffaError && error.code === 'collaboration_limit') {
          const notice = this.store.prepareOutput(binding.id, `limit:${root.id}`, null, error.message, {
            kind: 'notice',
          })
          void this.delivery.enqueue(notice.id)
        } else throw error
      }
    }
  }
  async stop(bindingId: string, cancelQueued = true) {
    await this.serial(bindingId, () => this.stopBinding(bindingId, cancelQueued))
    this.emit({ type: 'change', bindingId })
  }
  private async stopBinding(bindingId: string, cancelQueued = true) {
    const b = this.store.binding(bindingId)
    const queued = cancelQueued ? await this.engine.pending(b.sessionId) : []
    await this.engine.stop(b.sessionId, cancelQueued)
    this.presentation.interrupt(b)
    this.engine.debug.clear(b.sessionId)
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
      await this.stopWatching(bindingId)
      this.presentation.clear(this.store.binding(bindingId))
    })
    this.emit({ type: 'change', bindingId })
  }
  async removeConversation(bindingId: string) {
    await this.serial(bindingId, async () => {
      const binding = this.store.binding(bindingId)
      this.store.archive(bindingId)
      await this.stopWatching(bindingId)
      this.presentation.clear(binding)
      // OpenCode interrupts execution, waits for idle, and removes its session history.
      try {
        await this.engine.native.sessions.remove({ sessionID: binding.sessionId })
      } catch (error) {
        // A previous attempt may have removed the native session before the local transaction committed.
        if ((error as { _tag?: string })?._tag !== 'SessionNotFoundError') throw error
      }
      this.store.remove(bindingId)
    })
    this.emit({ type: 'change', bindingId })
  }
  async reset(bindingId: string) {
    return this.serial(bindingId, () => this.resetBinding(bindingId))
  }
  private async resetBinding(bindingId: string, input?: Inbound) {
    const previous = this.store.binding(bindingId)
    const info = await this.engine.native.sessions.get({ sessionID: previous.sessionId })
    await this.stopBinding(bindingId)
    await this.stopWatching(bindingId)
    this.presentation.clear(previous)
    if (input?.command) input.command.previousSessionId = previous.sessionId
    const next = this.store.replace({ ...previous, agent: info.agent ?? previous.agent }, input)
    if (input) await this.submit(this.store.inbound(input.id)!)
    else {
      await this.ensure(next)
      if (info.model && !this.adapters.get(next.adapterId)?.model)
        await this.engine.native.sessions.switchModel({ sessionID: next.sessionId, model: info.model })
    }
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
      this.stream,
      ...[...this.watchers.values()].map((watcher) => watcher.promise),
      ...this.submissions.values(),
    ])
    await this.delivery.flush()
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.stop()))
    await this.engine.close()
    this.store.close()
  }
}

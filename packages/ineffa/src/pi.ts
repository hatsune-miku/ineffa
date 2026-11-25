import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Type } from 'typebox'

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  type AgentSession,
  type AgentSessionEvent,
  DefaultResourceLoader,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
} from '@earendil-works/pi-coding-agent'

import type {
  Engine,
  EngineEvent,
  EngineForm,
  EngineMessage,
  EngineSession,
  EngineTokens,
  FormAnswer,
  ModelReference,
} from './engine'
import { PiDebug } from './pi-debug'
import { PiJournal, type PiSessionRecord } from './pi-journal'
import { PiResources, type PiResourcesConfig, piDirectories } from './pi-resources'
import { piTransport } from './pi-transport'
import type { AccountPrompt } from './prompt'
import { identity } from './store'
import { type Attachment, type Binding, type Inbound, IneffaError } from './types'

export type PiModel = {
  id: string
  provider: string
  name?: string
  baseURL: string
  apiKey: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ('text' | 'image')[]
}

export type PiOptions = {
  resolveModel: (reference: string) => Promise<PiModel | undefined>
  resources?: (directory: string) => Promise<PiResourcesConfig>
}

type RunningSession = {
  session: AgentSession
  record: PiSessionRecord
  inputId?: string
  assistantId?: string
  messageIds: WeakMap<object, string>
  failed: boolean
  processing?: Promise<void>
  stopping: boolean
  resources: PiResources
}

const directories = Object.keys(piDirectories)
type Transcript = { record: PiSessionRecord; session: Pick<AgentSession, 'sessionManager'> }

function followingToolResults(entries: SessionEntry[], assistantIndex: number) {
  const results = new Map<string, ToolResultMessage>()
  for (let index = assistantIndex + 1; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.type !== 'message') continue
    if (entry.message.role === 'assistant' || entry.message.role === 'user') break
    if (entry.message.role === 'toolResult') results.set(entry.message.toolCallId, entry.message)
  }
  return results
}

function emptyTokens(): EngineTokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function tokens(message: AssistantMessage): EngineTokens {
  return {
    input: message.usage.input,
    output: message.usage.output,
    reasoning: 0,
    cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
  }
}

function textContent(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text))
    .join('\n')
}

/** In-process Pi runtime. Native JSONL owns history; the journal owns accepted input and delivery receipts. */
export class PiBridge implements Engine {
  readonly backend = 'pi'
  readonly capabilities = { permissions: false, agents: false, compact: true, steer: false }
  readonly debug = new PiDebug()
  private sessions = new Map<string, Promise<RunningSession>>()
  private listeners = new Set<(event: EngineEvent) => void>()
  private forms = new Map<string, { resolve: (answer: FormAnswer) => void; reject: (error: Error) => void }>()
  private resolvePrompt: (sessionId: string) => AccountPrompt | undefined = () => undefined
  private fileAvailable: (sessionId: string) => boolean = () => false
  private sendFile?: Parameters<Engine['configureFileTool']>[1]
  private closed = false

  private constructor(
    readonly directory: string,
    private options: PiOptions,
    private journal: PiJournal
  ) {}

  static async open(directory: string, options: PiOptions) {
    await mkdir(directory, { recursive: true })
    const journal = new PiJournal(join(directory, 'delivery.sqlite'))
    journal.recover()
    return new PiBridge(directory, options, journal)
  }

  async configureFileTool(available: (sessionId: string) => boolean, send: Parameters<Engine['configureFileTool']>[1]) {
    this.fileAvailable = available
    this.sendFile = send
  }

  async configureAccountPrompts(resolvePrompt: (sessionId: string) => AccountPrompt | undefined) {
    this.resolvePrompt = resolvePrompt
  }

  async ready(_directory: string) {}

  async ensure(binding: Binding, model?: string) {
    if (!this.journal.session(binding.sessionId)) {
      const reference = model ?? binding.model
      if (!reference) throw new IneffaError('model_required', '请为 Pi 账号绑定模型。')
      await this.resolveModel(reference)
      const manager = SessionManager.create(binding.directory, join(this.directory, 'sessions'), {
        id: binding.sessionId,
      })
      this.journal.addSession({
        id: binding.sessionId,
        directory: binding.directory,
        file: manager.getSessionFile()!,
        title: binding.address.title,
        model: reference,
        agent: binding.agent,
      })
    }
    const saved = this.journal.session(binding.sessionId)!
    if (model && model !== saved.model && !this.sessions.has(binding.sessionId)) {
      await this.resolveModel(model)
      this.journal.db.query('UPDATE sessions SET model=? WHERE id=?').run(model, binding.sessionId)
    }
    const runtime = await this.load(binding.sessionId)
    if (model && model !== runtime.record.model) {
      const separator = model.indexOf('/')
      await this.switchModel(binding.sessionId, {
        providerID: model.slice(0, separator),
        id: model.slice(separator + 1),
      })
    }
    this.drain(runtime)
    return this.getSession(binding.sessionId)
  }

  private async resolveModel(reference: string) {
    const model = await this.options.resolveModel(reference)
    if (!model) throw new IneffaError('model_not_found', 'Pi 绑定的模型不存在或不支持 OpenAI 兼容接口。')
    return model
  }

  private load(sessionId: string) {
    let loading = this.sessions.get(sessionId)
    if (!loading) {
      loading = this.createSession(sessionId)
      this.sessions.set(sessionId, loading)
      void loading.catch(() => this.sessions.delete(sessionId))
    }
    return loading
  }

  private async createSession(sessionId: string): Promise<RunningSession> {
    const record = this.journal.session(sessionId)
    if (!record) throw new IneffaError('session_not_found', '会话不存在。', 404)
    await mkdir(record.directory, { recursive: true })
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      authPath: join(this.directory, 'auth.json'),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    const model = await this.configureModel(modelRuntime, record.model, sessionId)
    const resources = new PiResources(
      record.directory,
      this.directory,
      await this.options.resources?.(record.directory)
    )
    let sessionForPrompt: AgentSession
    const settingsManager = SettingsManager.inMemory({
      defaultTools: directories,
      compaction: { enabled: true },
      retry: { enabled: false },
      cacheWarming: 'off',
    })
    const loader = new DefaultResourceLoader({
      cwd: record.directory,
      agentDir: this.directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      skillsOverride: () => resources.reloadSkills(),
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: 'You are a general-purpose assistant.',
      extensionFactories: [
        ...resources.extensions(),
        (pi) => {
          pi.on('before_agent_start', async (_event, context) => {
            await resources.restore(sessionForPrompt, this.fileAvailable(record.id), context.signal)
            return { systemPrompt: this.systemPrompt(record, resources, sessionForPrompt) }
          })
        },
      ],
    })
    await loader.reload()
    const manager = (await Bun.file(record.file).exists())
      ? SessionManager.open(record.file)
      : SessionManager.create(record.directory, join(this.directory, 'sessions'), { id: sessionId })
    if (manager.getSessionFile() !== record.file) {
      record.file = manager.getSessionFile()!
      this.journal.db.query('UPDATE sessions SET file=? WHERE id=?').run(record.file, sessionId)
    }
    const { session } = await createAgentSession({
      cwd: record.directory,
      agentDir: this.directory,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      customTools: this.tools(record, resources),
      thinkingLevel: model.reasoning ? 'medium' : 'off',
    })
    const runtime: RunningSession = {
      session,
      record,
      messageIds: new WeakMap(),
      failed: false,
      stopping: false,
      resources,
    }
    sessionForPrompt = session
    session.subscribe((event) => this.observe(runtime, event))
    await session.bindExtensions({ mode: 'rpc' })
    return runtime
  }

  private async configureModel(runtime: ModelRuntime, reference: string, sessionId: string) {
    const configured = await this.resolveModel(reference)
    runtime.registerProvider(configured.provider, {
      api: 'openai-completions',
      baseUrl: configured.baseURL,
      streamSimple: piTransport(this.debug, sessionId),
      models: [
        {
          id: configured.id,
          name: configured.name ?? configured.id,
          reasoning: configured.reasoning ?? false,
          input: configured.input ?? ['text'],
          contextWindow: configured.contextWindow ?? 128_000,
          maxTokens: configured.maxTokens ?? 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    })
    await runtime.setRuntimeApiKey(configured.provider, configured.apiKey)
    const model = runtime.getModel(configured.provider, configured.id)
    if (!model) throw new Error('无法加载 Pi 模型。')
    return model
  }

  private systemPrompt(record: PiSessionRecord, resources: PiResources, session: AgentSession) {
    const prompt = this.resolvePrompt(record.id)
    const files = this.fileAvailable(record.id)
    const browserCount = resources.names(session, 'browser', files).length
    const genericCount = resources.names(session, 'generic', files).length
    const browserServers = resources.serverCount('browser')
    const genericServers = resources.serverCount('generic')
    return [
      prompt?.system,
      prompt?.context,
      '你由 Pi 驱动，但不代表你是编程/开发特化的 Agent——不要假设用户的专业领域，你只作为通用智能处理用户的请求。',
      `Environment: ${JSON.stringify({ sessionId: record.id, directory: record.directory, platform: process.platform, date: new Date().toISOString().slice(0, 10) })}`,
      `${resources.skills().skills.filter((skill) => !skill.disableModelInvocation).length} skills loaded. Call \`list_skills\` to view.`,
      `${browserCount} browser-specific tools loaded${browserServers ? `; ${browserServers} servers available on demand` : ''}. Call \`list_browser_tools\` to view.`,
      `${resources.names(session, 'coding', files).length} OpenCode and coding-specific tools loaded. Call \`list_coding_tools\` to view.`,
      `${genericCount} generic tools loaded${genericServers ? `; ${genericServers} servers available on demand` : ''}. Call \`list_tools\` to view.`,
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private tools(record: PiSessionRecord, resources: PiResources): ToolDefinition[] {
    const tools: ToolDefinition[] = directories.map((name) => ({
      name,
      label: name,
      description: `List available ${name.slice(5).replaceAll('_', ' ')} and enable their tool definitions for subsequent calls.`,
      parameters: Type.Object({}),
      async execute() {
        return { content: [], details: {} }
      },
    }))
    for (const tool of tools) {
      tool.execute = async (_callId, _input, signal) => {
        const { session } = await this.load(record.id)
        const group = piDirectories[tool.name as keyof typeof piDirectories]
        const unavailable = await resources.connect(group, signal)
        const names = resources.names(session, group, this.fileAvailable(record.id))
        session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...names])])
        const definitions = names
          .map((name) => session.getToolDefinition(name))
          .filter(Boolean)
          .map((definition) => ({
            name: definition!.name,
            description: definition!.description,
            input: definition!.parameters,
          }))
        const result =
          group === 'skills'
            ? {
                skills: resources
                  .skills()
                  .skills.filter((skill) => !skill.disableModelInvocation)
                  .map((skill) => ({
                    name: skill.name,
                    description: skill.description,
                    path: skill.filePath,
                  })),
                tools: definitions,
              }
            : { tools: definitions, unavailable }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} }
      }
    }
    tools.push({
      name: 'send_file',
      label: 'Send file',
      description:
        'Send a local file or image from the current workspace to the user. Do not retry deliveries reported as unknown.',
      defaultActive: false,
      parameters: Type.Object({ path: Type.String(), caption: Type.Optional(Type.String()) }),
      execute: async (callId, raw) => {
        const input = raw as { path: string; caption?: string }
        const runtime = await this.load(record.id)
        if (!this.fileAvailable(record.id) || !this.sendFile || !runtime.assistantId) {
          throw new Error('此会话不支持发送附件。')
        }
        const text = await this.sendFile(record.id, runtime.assistantId, callId, input.path, input.caption ?? '')
        return { content: [{ type: 'text', text }], details: {} }
      },
    })
    tools.push({
      name: 'question',
      label: 'Ask user',
      description: 'Ask the user a question and wait for their answer. Provide optional suggested choices.',
      defaultActive: false,
      parameters: Type.Object({
        question: Type.String(),
        options: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (callId, raw, signal) => {
        const input = raw as { question: string; options?: string[] }
        const runtime = await this.load(record.id)
        const form: EngineForm = {
          id: identity('form_', record.id, callId),
          sessionID: record.id,
          title: input.question,
          metadata: { kind: 'question', tool: { messageID: runtime.assistantId, id: callId } },
          fields: [
            {
              key: 'answer',
              type: 'string',
              title: input.question,
              custom: true,
              options: input.options?.map((option) => ({ value: option, label: option })),
            },
          ],
        }
        const answer = await this.ask(form, signal)
        return { content: [{ type: 'text', text: JSON.stringify(answer) }], details: {} }
      },
    })
    return tools
  }

  async submit(binding: Binding, input: Inbound, files: Attachment[] = input.message.files ?? []) {
    if (input.command) throw new Error('Slash 命令不能提交给模型。')
    const runtime = await this.load(binding.sessionId)
    if (!this.journal.input(input.id)) this.journal.accept(binding.sessionId, input, files)
    this.drain(runtime)
    return { id: input.id }
  }

  private drain(runtime: RunningSession) {
    if (runtime.processing || runtime.stopping || this.closed) return
    runtime.processing = this.process(runtime).finally(() => {
      runtime.processing = undefined
      if (!runtime.stopping && !this.closed && this.journal.pending(runtime.record.id).length) this.drain(runtime)
    })
    void runtime.processing.catch(() => {})
  }

  private async process(runtime: RunningSession) {
    const sessionID = runtime.record.id
    while (!runtime.stopping && !this.closed) {
      const pending = this.journal.pending(sessionID)[0]
      if (!pending) break
      runtime.inputId = pending.id
      runtime.failed = false
      this.journal.state(pending.id, 'running')
      this.debug.start(sessionID)
      this.publish(sessionID, { type: 'session.execution.started', data: { sessionID }, created: Date.now() })
      this.publish(sessionID, {
        type: 'session.inbox.delivered',
        data: { sessionID, inboxID: pending.id },
        created: Date.now(),
      })
      try {
        const nextResources = (await this.options.resources?.(runtime.record.directory)) ?? {}
        if (runtime.resources.update(nextResources)) await runtime.session.reload()
        const model = await this.configureModel(runtime.session.modelRuntime, runtime.record.model, sessionID)
        await runtime.session.setModel(model)
        const attachments = await this.attachments(pending.files)
        if (attachments.images.length && !model.input.includes('image')) {
          throw new IneffaError('model_image_unsupported', '当前 Pi 模型不支持图片，请切换支持图片的模型。')
        }
        if (runtime.stopping || this.closed) throw new Error('执行已停止。')
        await runtime.session.prompt([pending.input.prompt, attachments.text].filter(Boolean).join('\n\n'), {
          images: attachments.images,
          expandPromptTemplates: false,
          source: 'rpc',
        })
        this.journal.state(pending.id, runtime.stopping ? 'interrupted' : 'done')
        this.publish(sessionID, {
          type: runtime.stopping
            ? 'session.execution.interrupted'
            : runtime.failed
              ? 'session.execution.failed'
              : 'session.execution.succeeded',
          data: { sessionID },
          created: Date.now(),
        })
      } catch (error) {
        this.journal.state(pending.id, 'interrupted')
        if (!runtime.stopping) this.recordFailure(runtime, error)
        this.publish(sessionID, {
          type: runtime.stopping ? 'session.execution.interrupted' : 'session.execution.failed',
          data: { sessionID },
          created: Date.now(),
        })
        if (!runtime.stopping)
          this.publish(
            sessionID,
            {
              type: 'session.status',
              data: { sessionID, error: error instanceof Error ? error.message : String(error) },
              created: Date.now(),
            },
            false
          )
      } finally {
        runtime.inputId = undefined
        runtime.assistantId = undefined
      }
    }
  }

  private recordFailure(runtime: RunningSession, error: unknown) {
    const sessionID = runtime.record.id
    const model = runtime.session.model!
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    const entryId = runtime.session.sessionManager.appendMessage(message)
    const assistantMessageID = identity('msg_', sessionID, entryId)
    this.journal.mapMessage(assistantMessageID, sessionID, runtime.inputId!, entryId)
    this.debug.step(sessionID, assistantMessageID)
    this.publish(sessionID, {
      type: 'session.step.started',
      data: { sessionID, assistantMessageID },
      created: Date.now(),
    })
    this.publish(sessionID, {
      type: 'session.step.failed',
      data: { sessionID, assistantMessageID, tokens: emptyTokens(), finish: 'error' },
      created: Date.now(),
    })
  }

  private async attachments(files: Attachment[]) {
    const images: ImageContent[] = []
    const references: string[] = []
    for (const file of files) {
      if (file.mime?.startsWith('image/')) {
        let bytes: Uint8Array
        if (file.uri.startsWith('file:')) bytes = await readFile(fileURLToPath(file.uri))
        else if (file.uri.startsWith('data:')) bytes = new Uint8Array(await (await fetch(file.uri)).arrayBuffer())
        else {
          references.push(`Attachment: ${file.name ?? ''} ${file.uri}`)
          continue
        }
        if (bytes.length > 20 * 1024 * 1024) throw new Error('附件超过 20 MiB。')
        images.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: file.mime })
      } else
        references.push(
          `Attachment: ${file.name ?? ''} ${file.uri.startsWith('file:') ? fileURLToPath(file.uri) : file.uri}`
        )
    }
    return { images, text: references.join('\n') }
  }

  private observe(runtime: RunningSession, event: AgentSessionEvent) {
    const sessionID = runtime.record.id
    if (event.type === 'compaction_start') this.debug.suspend(sessionID, true)
    if (event.type === 'compaction_end') this.debug.suspend(sessionID, false)
    const created = Date.now()
    if (!runtime.inputId) return
    if (event.type === 'message_end' && event.message.role === 'user') {
      const inputId = runtime.inputId
      // Pi persists message_end immediately after notifying subscribers.
      queueMicrotask(() => {
        const entry = runtime.session.sessionManager
          .getEntries()
          .find((entry) => entry.type === 'message' && entry.message === event.message)
        if (entry) this.journal.mapMessage(inputId, sessionID, inputId, entry.id)
      })
    } else if (event.type === 'message_start' && event.message.role === 'assistant') {
      runtime.assistantId = identity('msg_', sessionID, randomUUID())
      runtime.messageIds.set(event.message, runtime.assistantId)
      this.journal.mapMessage(runtime.assistantId, sessionID, runtime.inputId)
      this.debug.step(sessionID, runtime.assistantId)
      this.publish(sessionID, {
        type: 'session.step.started',
        data: { sessionID, assistantMessageID: runtime.assistantId },
        created,
      })
    } else if (event.type === 'message_update' && runtime.assistantId) {
      const update = event.assistantMessageEvent
      const data = { sessionID, assistantMessageID: runtime.assistantId }
      if (update.type === 'text_delta') {
        this.publish(
          sessionID,
          { type: 'session.text.delta', data: { ...data, ordinal: update.contentIndex, delta: update.delta }, created },
          false
        )
      } else if (update.type === 'thinking_start' || update.type === 'thinking_end') {
        this.publish(sessionID, {
          type: update.type === 'thinking_start' ? 'session.reasoning.started' : 'session.reasoning.ended',
          data,
          created,
        })
      }
    } else if (event.type === 'tool_execution_start') {
      const id = `${runtime.assistantId}:${event.toolCallId}`
      if (!directories.includes(event.toolName)) this.debug.tool(sessionID, id, false)
      this.publish(sessionID, {
        type: 'session.tool.input.started',
        data: { sessionID, id, name: event.toolName },
        created,
      })
    } else if (event.type === 'tool_execution_end') {
      if (!directories.includes(event.toolName))
        this.debug.tool(sessionID, `${runtime.assistantId}:${event.toolCallId}`, true)
    } else if (event.type === 'turn_end') {
      const message = event.message
      if (message.role !== 'assistant') return
      const entry = runtime.session.sessionManager
        .getEntries()
        .find((entry) => entry.type === 'message' && entry.message === message)
      if (!entry) throw new Error('Pi 未持久化本轮回答。')
      const assistantMessageID =
        runtime.messageIds.get(message) ?? runtime.assistantId ?? identity('msg_', sessionID, entry.id)
      this.journal.mapMessage(assistantMessageID, sessionID, runtime.inputId, entry.id)
      runtime.failed ||= message.stopReason === 'error'
      this.publish(sessionID, {
        type:
          message.stopReason === 'error' || message.stopReason === 'aborted'
            ? 'session.step.failed'
            : 'session.step.ended',
        data: {
          sessionID,
          assistantMessageID,
          tokens: tokens(message),
          finish: message.stopReason === 'toolUse' ? 'tool-calls' : message.stopReason,
        },
        created,
      })
    }
  }

  private publish(sessionId: string, event: EngineEvent, durable = true) {
    const published = durable ? this.journal.append(sessionId, event) : event
    for (const listener of this.listeners) listener(published)
  }

  async *events(signal: AbortSignal): AsyncIterable<EngineEvent> {
    const queue: EngineEvent[] = []
    let wake: (() => void) | undefined
    const listener = (event: EngineEvent) => {
      queue.push(event)
      wake?.()
    }
    const abort = () => wake?.()
    this.listeners.add(listener)
    signal.addEventListener('abort', abort)
    try {
      while (!signal.aborted && !this.closed) {
        if (!queue.length)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        wake = undefined
        while (queue.length && !signal.aborted) yield queue.shift()!
      }
    } finally {
      this.listeners.delete(listener)
      signal.removeEventListener('abort', abort)
    }
  }

  async *log(binding: Binding, signal: AbortSignal): AsyncIterable<EngineEvent> {
    let cursor = binding.cursor
    let wake: (() => void) | undefined
    const notify = () => wake?.()
    this.listeners.add(notify)
    signal.addEventListener('abort', notify)
    try {
      while (!signal.aborted && !this.closed) {
        const events = this.journal.events(binding.sessionId, cursor)
        if (events.length) {
          for (const event of events) {
            cursor = event.durable!.seq
            yield event
          }
        } else
          await new Promise<void>((resolve) => {
            wake = resolve
          })
      }
    } finally {
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  private async transcript(sessionId: string): Promise<Transcript> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const record = this.journal.session(sessionId)
    if (!record) throw new IneffaError('session_not_found', '会话不存在。', 404)
    const manager = (await Bun.file(record.file).exists())
      ? SessionManager.open(record.file)
      : SessionManager.inMemory(record.directory, { id: sessionId })
    return { record, session: { sessionManager: manager } }
  }

  async getSession(sessionId: string): Promise<EngineSession> {
    const { session, record } = await this.transcript(sessionId)
    const total = emptyTokens()
    let cost = 0
    for (const entry of session.sessionManager.getEntries()) {
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
      const usage = tokens(entry.message)
      total.input += usage.input
      total.output += usage.output
      total.cache.read += usage.cache.read
      total.cache.write += usage.cache.write
      cost += entry.message.usage.cost.total
    }
    const separator = record.model.indexOf('/')
    return {
      id: sessionId,
      agent: record.agent,
      model: { providerID: record.model.slice(0, separator), id: record.model.slice(separator + 1) },
      tokens: total,
      cost,
    }
  }

  async switchModel(sessionId: string, model: ModelReference) {
    const reference = `${model.providerID}/${model.id}`
    await this.resolveModel(reference)
    if (!this.journal.session(sessionId)) throw new IneffaError('session_not_found', '会话不存在。', 404)
    this.journal.db.query('UPDATE sessions SET model=? WHERE id=?').run(reference, sessionId)
    const runtime = await this.load(sessionId)
    runtime.record.model = reference
    if (!runtime.processing)
      await runtime.session.setModel(await this.configureModel(runtime.session.modelRuntime, reference, sessionId))
  }

  async renameSession(sessionId: string, title: string) {
    const runtime = await this.transcript(sessionId)
    runtime.session.sessionManager.appendSessionInfo(title)
    runtime.record.title = title
    this.journal.db.query('UPDATE sessions SET title=? WHERE id=?').run(title, sessionId)
  }

  async removeSession(sessionId: string) {
    const record = this.journal.session(sessionId)
    if (!record) throw new IneffaError('session_not_found', '会话不存在。', 404)
    await this.stop(sessionId)
    const runtime = this.sessions.get(sessionId)
    if (runtime) {
      const session = (await runtime).session
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }
    await rm(record.file, { force: true })
    this.sessions.delete(sessionId)
    this.journal.db.query('DELETE FROM sessions WHERE id=?').run(sessionId)
  }

  async releaseSession(sessionId: string) {
    const loading = this.sessions.get(sessionId)
    if (!loading) return
    const runtime = await loading
    runtime.stopping = true
    await runtime.session.abort()
    await runtime.processing
    await runtime.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    runtime.session.dispose()
    this.sessions.delete(sessionId)
  }

  async exportSession(sessionId: string) {
    const { session, record } = await this.transcript(sessionId)
    return { backend: this.backend, session: record, entries: session.sessionManager.getEntries() }
  }

  async compactSession(sessionId: string) {
    const runtime = await this.load(sessionId)
    if (runtime.processing || !runtime.session.isIdle) {
      throw new IneffaError('session_busy', '请等待当前执行结束后再压缩会话。', 409)
    }
    const compaction = runtime.session.compact()
    runtime.processing = compaction.then(
      () => {},
      () => {}
    )
    try {
      return await compaction
    } finally {
      runtime.processing = undefined
      this.drain(runtime)
    }
  }

  async active() {
    return Object.fromEntries(
      (
        await Promise.all(
          [...this.sessions].map(
            async ([id, promise]) =>
              [
                id,
                await promise.then(
                  (runtime) => Boolean(runtime.processing),
                  () => false
                ),
              ] as const
          )
        )
      ).filter(([, active]) => active)
    )
  }

  async messages(sessionId: string, cursor?: string) {
    const runtime = await this.transcript(sessionId)
    const entries = runtime.session.sessionManager.getEntries()
    const cursorEntry = cursor && (this.journal.message(cursor)?.entryId ?? cursor)
    const end = cursorEntry ? entries.findIndex((entry) => entry.id === cursorEntry) : entries.length
    const data: EngineMessage[] = []
    for (let index = end - 1; index >= 0; index--) {
      const entry = entries[index]!
      if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) continue
      if (data.length === 100) return { data, cursor: { next: data.at(-1)!.id } }
      const mapped = this.journal.db
        .query('SELECT id,inputId FROM messages WHERE sessionId=? AND entryId=?')
        .get(sessionId, entry.id) as { id: string; inputId: string } | null
      const results = entry.message.role === 'assistant' ? followingToolResults(entries, index) : undefined
      data.push(this.convertMessage(runtime, mapped?.id ?? entry.id, entry.message, mapped?.inputId, results))
    }
    return { data, cursor: { next: null } }
  }

  async message(sessionId: string, messageId: string) {
    const runtime = await this.transcript(sessionId)
    const mapping = this.journal.message(messageId)
    const entry = runtime.session.sessionManager.getEntry(mapping?.entryId ?? messageId)
    if (!entry || entry.type !== 'message') throw new IneffaError('message_not_found', '消息不存在。', 404)
    let results: Map<string, ToolResultMessage> | undefined
    if (entry.message.role === 'assistant' && entry.message.content.some((part) => part.type === 'toolCall')) {
      const entries = runtime.session.sessionManager.getEntries()
      results = followingToolResults(
        entries,
        entries.findIndex((item) => item.id === entry.id)
      )
    }
    return this.convertMessage(runtime, messageId, entry.message, mapping?.inputId, results)
  }

  private convertMessage(
    runtime: Transcript,
    id: string,
    message: AgentMessage,
    inputId?: string,
    results?: Map<string, ToolResultMessage>
  ): EngineMessage {
    const timestamp = 'timestamp' in message ? Number(message.timestamp) : Date.now()
    const base = {
      id,
      time: { created: timestamp, completed: timestamp },
      metadata: inputId ? { ineffa: { inputId } } : undefined,
    }
    if (message.role !== 'assistant')
      return { ...base, type: 'user', text: textContent('content' in message ? message.content : '') }
    return {
      ...base,
      type: 'assistant',
      agent: runtime.record.agent,
      error: message.stopReason === 'error' ? { message: message.errorMessage ?? '模型调用失败。' } : undefined,
      content: message.content.flatMap((part): Extract<EngineMessage, { type: 'assistant' }>['content'] => {
        if (part.type === 'text') return [{ type: 'text', text: part.text }]
        if (part.type === 'thinking') return [{ type: 'reasoning', text: part.thinking }]
        if (part.type === 'toolCall') {
          const result = results?.get(part.id)
          return [
            {
              type: 'tool',
              id: part.id,
              name: part.name,
              state: {
                status: result ? (result.isError ? 'error' : 'completed') : 'running',
                input: part.arguments,
                content: result ? [{ type: 'text', text: textContent(result.content) }] : undefined,
              },
            },
          ]
        }
        return []
      }),
    }
  }

  async inputForAssistant(sessionId: string, messageId: string) {
    const mapping = this.journal.message(messageId)
    return mapping?.sessionId === sessionId ? mapping.inputId : undefined
  }

  async pending(sessionId: string) {
    return this.journal
      .pending(sessionId)
      .map(({ id, input }) => ({ id, delivery: 'queue', type: 'prompt', payload: { text: input.prompt } }))
  }

  async cancelPending(sessionId: string, inputId: string) {
    const input = this.journal.input(inputId)
    if (!input || input.sessionId !== sessionId) throw new IneffaError('input_not_found', '排队消息不存在。', 404)
    if (input.state === 'cancelled') return
    if (input.state !== 'queued') throw new IneffaError('input_not_queued', '此消息已经开始执行，请使用停止操作。', 409)
    this.journal.state(inputId, 'cancelled')
  }

  async steerPending(_sessionId: string, _inputId: string): Promise<never> {
    throw new IneffaError('unsupported_backend_feature', 'Pi 暂不支持将排队消息插入当前执行。')
  }

  async stop(sessionId: string, cancelQueued = true) {
    if (cancelQueued) for (const input of this.journal.pending(sessionId)) this.journal.state(input.id, 'cancelled')
    const loading = this.sessions.get(sessionId)
    if (!loading) return
    const runtime = await loading
    runtime.stopping = true
    await runtime.session.abort()
    await runtime.processing
    runtime.stopping = false
    if (!cancelQueued) this.drain(runtime)
  }

  private async ask(form: EngineForm, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('提问已取消。')
    this.journal.addForm(form)
    let abort: (() => void) | undefined
    try {
      return await new Promise<FormAnswer>((resolve, reject) => {
        this.forms.set(form.id, { resolve, reject })
        abort = () => {
          void this.cancelForm(form.sessionID, form.id)
        }
        signal?.addEventListener('abort', abort, { once: true })
        this.publish(form.sessionID, { type: 'form.created', data: { form }, created: Date.now() }, false)
      })
    } finally {
      this.forms.delete(form.id)
      if (abort) signal?.removeEventListener('abort', abort)
    }
  }

  async listForms(sessionId: string) {
    return (
      this.journal.db.query("SELECT id FROM forms WHERE sessionId=? AND status='pending'").all(sessionId) as {
        id: string
      }[]
    ).map(({ id }) => this.journal.form(id)!.form)
  }

  async getFormState(sessionId: string, formId: string) {
    const row = this.journal.form(formId)
    return row?.form.sessionID === sessionId ? { status: row.status } : undefined
  }

  async replyForm(sessionId: string, formId: string, answer: FormAnswer) {
    const row = this.journal.form(formId)
    if (!row || row.form.sessionID !== sessionId) throw new IneffaError('form_not_found', '问题不存在。', 404)
    if (row.status !== 'pending') return
    if (typeof answer.answer !== 'string' || !answer.answer.trim())
      throw new IneffaError('invalid_answer', '请输入回答。')
    this.journal.finishForm(formId, 'submitted', answer)
    this.forms.get(formId)?.resolve(answer)
    this.publish(sessionId, { type: 'form.replied', data: { id: formId }, created: Date.now() }, false)
  }

  async cancelForm(sessionId: string, formId: string) {
    const row = this.journal.form(formId)
    if (!row || row.form.sessionID !== sessionId || row.status !== 'pending') return
    this.journal.finishForm(formId, 'cancelled')
    this.forms.get(formId)?.reject(new Error('用户取消了提问。'))
    this.publish(sessionId, { type: 'form.cancelled', data: { id: formId }, created: Date.now() }, false)
  }

  async close() {
    this.closed = true
    for (const [id, promise] of this.sessions) {
      const runtime = await promise
      await this.stop(id, false)
      await runtime.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      runtime.session.dispose()
    }
    for (const listener of this.listeners) listener({ type: 'session.status', data: {}, created: Date.now() })
    this.journal.db.close()
  }
}

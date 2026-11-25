import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Plugin } from '@opencode/plugin'
import type { OpenCode, OpenCodeEvent } from '@opencode/sdk'

import { browserRuntime } from './browser'
import { DebugTimings } from './debug'
import {
  type Engine,
  type EngineEvent,
  type EngineMessage,
  type FormAnswer,
  type ModelReference,
  sourceInputId,
} from './engine'
import { modelReference } from './model'
import { createEmbedded } from './opencode-runtime'
import { silentPermissions } from './permissions'
import type { AccountPrompt } from './prompt'
import { identity } from './store'
import { instructionOverrides, toolDirectory } from './tool-directory'
import type { Attachment, Binding, Inbound } from './types'

export type OpenCodeOptions = Omit<OpenCode.CreateOptions, 'database'> & { browser?: boolean }
export type { EngineMessage } from './engine'
export { sourceInputId } from './engine'

export class OpenCodeBridge implements Engine {
  readonly backend = 'opencode' as const
  readonly capabilities = { permissions: true, agents: true, compact: true, steer: true }
  private constructor(
    readonly native: OpenCode.Interface,
    readonly debug: DebugTimings,
    readonly configDirectory: string,
    readonly databasePath: string
  ) {}

  async configureFileTool(
    available: (sessionId: string) => boolean,
    send: (sessionId: string, messageId: string, callId: string, path: string, caption: string) => Promise<string>
  ) {
    const engine = this
    await this.native.plugin(
      Plugin.define({
        id: 'ineffa.send-file',
        async setup(context) {
          await context.tool.transform((editor) =>
            editor.add({
              name: 'send_file',
              description:
                'Send a file or image from the current account workspace to the current platform conversation. Uploads and sends an actual attachment. Use only for files intended for the user. Relative paths resolve within the workspace. Maximum 20 MiB. Do not repeat a delivery reported as unknown.',
              options: { codemode: false },
              input: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Local file path inside the account workspace.' },
                  caption: { type: 'string', description: 'Optional short caption.' },
                },
                required: ['path'],
                additionalProperties: false,
              },
              async execute(input, tool) {
                const value = input as { path: string; caption?: string }
                await engine.authorizeFile(tool.sessionID, tool.agent, tool.messageID, tool.id, value.path)
                return { content: await send(tool.sessionID, tool.messageID, tool.id, value.path, value.caption ?? '') }
              },
            })
          )
          await context.session.hook('context', (event) => {
            if (!available(event.sessionID)) delete event.tools.send_file
          })
        },
      })
    )
  }
  private async authorizeFile(sessionId: string, agent: string, messageId: string, callId: string, path: string) {
    const controller = new AbortController()
    const requestId = identity('per_', sessionId, messageId, callId)
    let decide!: (allowed: boolean) => void
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve
    })
    const events = this.native.events.subscribe({ signal: controller.signal })
    const listener = (async () => {
      try {
        for await (const event of events) {
          if (event.type === 'permission.replied' && event.data.requestID === requestId) {
            decide(event.data.reply !== 'reject')
            return
          }
          if (event.type === 'session.execution.interrupted' && event.data.sessionID === sessionId) return
        }
      } finally {
        decide(false)
      }
    })().catch(() => {
      decide(false)
    })
    let waiting = false
    try {
      const result = await this.native.permission.create({
        id: requestId,
        sessionID: sessionId,
        agent,
        action: 'send_file',
        resources: [path],
        source: { type: 'tool', messageID: messageId, id: callId },
      })
      waiting = result.effect === 'ask'
      if (result.effect === 'deny' || (waiting && !(await decision))) throw new Error('未获准发送此附件。')
      waiting = false
    } finally {
      controller.abort()
      await listener
      if (waiting)
        await this.native.permission
          .reply({ sessionID: sessionId, requestID: requestId, reply: 'reject' })
          .catch(() => {})
    }
  }
  async inputForAssistant(sessionId: string, messageId: string): Promise<string | undefined> {
    let cursor: string | undefined
    let found = false
    do {
      const page = await this.messages(sessionId, cursor)
      for (const message of page.data) {
        if (message.id === messageId) found = true
        else if (found && message.type === 'user') return sourceInputId(message)
      }
      cursor = page.cursor.next ?? undefined
    } while (cursor)
  }
  async configureAccountPrompts(resolvePrompt: (sessionId: string) => AccountPrompt | undefined) {
    await this.native.plugin(toolDirectory(resolvePrompt))
  }
  static async open(dataDirectory: string, options: OpenCodeOptions = {}) {
    const { browser: browserEnabled = true, ...nativeOptions } = options
    await mkdir(dataDirectory, { recursive: true })
    const configDirectory = resolve(options.config?.directory ?? resolve(dataDirectory, 'config'))
    await mkdir(configDirectory, { recursive: true })
    const debug = new DebugTimings()
    return new OpenCodeBridge(
      await createEmbedded(
        {
          ...nativeOptions,
          plugins: [silentPermissions, debug.plugin, ...(options.plugins ?? [])],
          app: { name: 'ineffa', version: '0.1.0', ...options.app },
          database: { path: resolve(dataDirectory, 'opencode.sqlite') },
          events: { persist: true },
          config: { directory: configDirectory, ...options.config },
        },
        { overrides: [...instructionOverrides, ...(browserEnabled ? [browserRuntime] : [])] }
      ),
      debug,
      configDirectory,
      resolve(dataDirectory, 'opencode.sqlite')
    )
  }
  async ensure(binding: Binding, model?: string) {
    if (binding.engineReady) return this.native.sessions.get({ sessionID: binding.sessionId })
    return this.native.sessions.create({
      id: binding.sessionId,
      title: binding.address.title,
      agent: binding.agent,
      model: modelReference(model),
      location: { directory: binding.directory },
    })
  }
  async submit(binding: Binding, input: Inbound, files: Attachment[] = input.message.files ?? []) {
    if (input.command) {
      throw new Error('控制命令不能提交到模型上下文。')
    }
    return this.native.sessions.prompt({
      sessionID: binding.sessionId,
      id: input.id,
      text: input.prompt,
      files,
      delivery: input.message.mode ?? 'queue',
      metadata: {
        ineffa: {
          inputId: input.id,
          rootId: input.rootId,
          author: input.message.author.name,
          sourceId: input.message.id,
        },
      },
    })
  }
  async *log(binding: Binding, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const events = this.native.sessions.log(
      { sessionID: binding.sessionId, after: binding.cursor || undefined, follow: true },
      { signal }
    )
    for await (const event of events) {
      const normalized = runtimeEvent(event)
      if (normalized) yield normalized
    }
  }
  async *events(signal: AbortSignal): AsyncIterable<EngineEvent> {
    for await (const event of this.native.events.subscribe({ signal })) {
      const normalized = runtimeEvent(event)
      if (normalized) yield normalized
    }
  }
  ready(directory: string) {
    return this.native.plugin.awaitActivation({ location: { directory } })
  }
  async message(sessionId: string, messageId: string) {
    return runtimeMessage(await this.native.sessions.message({ sessionID: sessionId, messageID: messageId }))
  }
  async messages(sessionId: string, cursor?: string) {
    const page = await this.native.message.list({ sessionID: sessionId, limit: 100, order: 'desc', cursor })
    return { ...page, data: page.data.map(runtimeMessage) }
  }
  async pending(sessionId: string) {
    const pending = await this.native.sessions.inbox.list({ sessionID: sessionId })
    return pending.map((item) => ({ ...item, payload: 'text' in item.payload ? { text: item.payload.text } : {} }))
  }
  async stop(sessionId: string, cancelQueued = true) {
    await this.native.sessions.interrupt({ sessionID: sessionId, continue: false })
    if (cancelQueued) {
      for (const item of await this.pending(sessionId)) {
        await this.native.sessions.inbox.cancel({ sessionID: sessionId, inboxID: item.id })
      }
    }
  }
  getSession(sessionId: string) {
    return this.native.sessions.get({ sessionID: sessionId })
  }
  switchModel(sessionId: string, model: ModelReference) {
    return this.native.sessions.switchModel({ sessionID: sessionId, model })
  }
  renameSession(sessionId: string, title: string) {
    return this.native.sessions.rename({ sessionID: sessionId, title })
  }
  removeSession(sessionId: string) {
    return this.native.sessions.remove({ sessionID: sessionId })
  }
  exportSession(sessionId: string) {
    return this.native.sessions.export({ sessionID: sessionId })
  }
  compactSession(sessionId: string) {
    return this.native.sessions.compact({ sessionID: sessionId })
  }
  active() {
    return this.native.sessions.active()
  }
  cancelPending(sessionId: string, inputId: string) {
    return this.native.sessions.inbox.cancel({ sessionID: sessionId, inboxID: inputId })
  }
  steerPending(sessionId: string, inputId: string) {
    return this.native.sessions.inbox.steer({ sessionID: sessionId, inboxID: inputId })
  }
  listForms(sessionId: string) {
    return this.native.form.list({ sessionID: sessionId })
  }
  getFormState(sessionId: string, formId: string) {
    return this.native.form.state({ sessionID: sessionId, formID: formId })
  }
  replyForm(sessionId: string, formId: string, answer: FormAnswer) {
    return this.native.form.reply({ sessionID: sessionId, formID: formId, answer })
  }
  cancelForm(sessionId: string, formId: string) {
    return this.native.form.cancel({ sessionID: sessionId, formID: formId })
  }
  close() {
    return this.native.close()
  }
}

type NativeJournalEvent =
  ReturnType<OpenCode.Interface['sessions']['log']> extends AsyncIterable<infer Event> ? Event : never

function runtimeEvent(event: OpenCodeEvent | NativeJournalEvent): EngineEvent | undefined {
  switch (event.type) {
    case 'session.execution.started':
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
    case 'session.step.started':
    case 'session.step.ended':
    case 'session.step.failed':
    case 'session.reasoning.started':
    case 'session.reasoning.ended':
    case 'session.tool.input.started':
    case 'session.inbox.delivered':
    case 'session.text.delta':
    case 'form.created':
    case 'form.replied':
    case 'form.cancelled':
    case 'permission.asked':
    case 'session.status':
      return event
    case 'server.connected':
      return { ...event, created: Date.now() }
  }
}

function runtimeMessage(message: Awaited<ReturnType<OpenCode.Interface['sessions']['message']>>): EngineMessage {
  if (
    message.type === 'user' ||
    message.type === 'assistant' ||
    message.type === 'synthetic' ||
    message.type === 'compaction'
  )
    return message
  return { id: message.id, time: message.time, type: 'internal', metadata: message.metadata }
}

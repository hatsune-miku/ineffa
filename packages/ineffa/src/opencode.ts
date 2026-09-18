import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Plugin } from '@opencode/plugin'
import type { OpenCode, OpenCodeEvent } from '@opencode/sdk'

import { browserRuntime } from './browser'
import { DebugTimings } from './debug'
import { modelReference } from './model'
import { createEmbedded } from './opencode-runtime'
import { silentPermissions } from './permissions'
import type { AccountPrompt } from './prompt'
import { identity } from './store'
import { instructionOverrides, toolDirectory } from './tool-directory'
import type { Attachment, Binding, Inbound } from './types'

export type EngineMessage = Awaited<ReturnType<OpenCode.Interface['sessions']['message']>>
export type OpenCodeOptions = Omit<OpenCode.CreateOptions, 'database'> & { browser?: boolean }

export function sourceInputId(message: EngineMessage): string {
  const source = message.metadata?.ineffa
  return source && typeof source === 'object' && !Array.isArray(source) && typeof source.inputId === 'string'
    ? source.inputId
    : message.id
}

export class OpenCodeBridge {
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
    const events = this.events(controller.signal)
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
  log(binding: Binding, signal: AbortSignal) {
    return this.native.sessions.log(
      { sessionID: binding.sessionId, after: binding.cursor || undefined, follow: true },
      { signal }
    )
  }
  events(signal: AbortSignal) {
    return this.native.events.subscribe({ signal })
  }
  ready(directory: string) {
    return this.native.plugin.awaitActivation({ location: { directory } })
  }
  message(sessionId: string, messageId: string) {
    return this.native.sessions.message({ sessionID: sessionId, messageID: messageId })
  }
  messages(sessionId: string, cursor?: string) {
    return this.native.message.list({ sessionID: sessionId, limit: 100, order: 'desc', cursor })
  }
  pending(sessionId: string) {
    return this.native.sessions.inbox.list({ sessionID: sessionId })
  }
  async stop(sessionId: string, cancelQueued = true) {
    await this.native.sessions.interrupt({ sessionID: sessionId, continue: false })
    if (cancelQueued) {
      for (const item of await this.pending(sessionId)) {
        await this.native.sessions.inbox.cancel({ sessionID: sessionId, inboxID: item.id })
      }
    }
  }
  close() {
    return this.native.close()
  }
}

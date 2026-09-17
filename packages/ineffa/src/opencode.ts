import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Plugin } from '@opencode/plugin'
import { OpenCode, type OpenCodeEvent } from '@opencode/sdk'

import { DebugTimings } from './debug'
import { modelReference } from './model'
import type { AccountPrompt } from './prompt'
import type { Attachment, Binding, Inbound } from './types'

export type EngineMessage = Awaited<ReturnType<OpenCode.Interface['sessions']['message']>>
export type OpenCodeOptions = Omit<OpenCode.CreateOptions, 'database'>

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
  async configureAccountPrompts(resolvePrompt: (sessionId: string) => AccountPrompt | undefined) {
    await this.native.plugin(
      Plugin.define({
        id: 'ineffa.account-prompt',
        async setup(context) {
          await context.session.hook('context', (event) => {
            const prompt = resolvePrompt(event.sessionID)
            if (!prompt) return

            // OpenCode 2.0.3 puts the selected agent's base prompt first.
            // Keep its remaining environment, project and tool instructions.
            if (prompt.system) event.system[0] = { type: 'text', text: prompt.system }
            event.system.push({ type: 'text', text: prompt.context })
          })
        },
      })
    )
  }
  static async open(dataDirectory: string, options: OpenCodeOptions = {}) {
    await mkdir(dataDirectory, { recursive: true })
    const configDirectory = resolve(options.config?.directory ?? resolve(dataDirectory, 'config'))
    await mkdir(configDirectory, { recursive: true })
    const debug = new DebugTimings()
    return new OpenCodeBridge(
      await OpenCode.create({
        ...options,
        instances: debug.instances(options.instances),
        app: { name: 'ineffa', version: '0.1.0', ...options.app },
        database: { path: resolve(dataDirectory, 'opencode.sqlite') },
        events: { persist: true },
        config: { directory: configDirectory, ...options.config },
      }),
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
  async submit(binding: Binding, input: Inbound, contextFiles: Attachment[] = []) {
    if (input.command) {
      throw new Error('控制命令不能提交到模型上下文。')
    }
    return this.native.sessions.prompt({
      sessionID: binding.sessionId,
      id: input.id,
      text: input.prompt,
      files: [...contextFiles, ...(input.message.files ?? [])],
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

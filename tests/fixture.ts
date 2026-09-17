import {
  type Adapter,
  type AdapterContext,
  type Address,
  type AgentPrompt,
  Host,
  type IncomingMessage,
  OpenCodeBridge,
  type OutgoingMessage,
  type SendResult,
  Store,
} from 'ineffa'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export async function until(check: () => unknown | Promise<unknown>, timeout = 15_000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition')
    await Bun.sleep(20)
  }
}
export class TestAdapter implements Adapter {
  name: string
  platformId: string
  agentPrompt?: AgentPrompt
  model?: string
  platform = 'test'
  agent = 'build'
  capabilities = { edit: true, attachments: false, history: false }
  context?: AdapterContext
  sent: OutgoingMessage[] = []
  outcome?: SendResult
  constructor(
    readonly id: string,
    readonly directory: string
  ) {
    this.name = id
    this.platformId = id
  }
  get identity() {
    return { id: this.platformId, name: this.id }
  }
  canAccess() {
    return true
  }
  conversationKey(address: Address): string | undefined {
    return address.kind === 'channel' ? address.id : undefined
  }
  async start(context: AdapterContext) {
    this.context = context
    context.status({ state: 'connected' })
  }
  async stop() {}
  async send(message: OutgoingMessage): Promise<SendResult> {
    this.sent.push(message)
    return this.outcome ?? { status: 'sent', messageId: `remote-${message.id}` }
  }
  mentions(text: string) {
    return [...text.matchAll(/@([ABC])/g)].map((m) => m[1]!)
  }
  mention(identity: { id: string }) {
    return `@${identity.id}`
  }
}
export type ModelRequest = { messages: { role: string; content: unknown }[]; [key: string]: unknown }
export function systemText(request: ModelRequest): string {
  return request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n')
}
export function modelAccount(request: ModelRequest): { displayName: string; platformId: string } | undefined {
  const match = /当前平台账号：(\{[^\n]+\})/.exec(systemText(request))
  return match ? JSON.parse(match[1]!) : undefined
}
export type ModelReply =
  | string
  | { tool: string; input: Record<string, unknown> }
  | {
      stream: { text?: string; thinking?: string; delay?: number }[]
      tool?: string
      input?: Record<string, unknown>
      usage?: { output: number; reasoning: number; input?: number; cached?: number }
    }
export async function fixture(
  reply: (request: ModelRequest) => ModelReply | Promise<ModelReply>,
  commands: Record<string, { template: string; description?: string }> = {},
  streamDelay = 0,
  filewatcher = false
) {
  const root = resolve(process.env.INEFFA_TEST_DIR ?? 'test-results/runtime')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'case-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const requests: ModelRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith('/models')) {
        return Response.json({
          data: [
            { id: 'echo', name: 'Local fixture' },
            { id: 'echo-alt', name: 'Alternative fixture' },
          ],
        })
      }
      if (!new URL(request.url).pathname.endsWith('/chat/completions'))
        return new Response('Not found', { status: 404 })
      const body = (await request.json()) as ModelRequest
      requests.push(body)
      const answer = await reply(body)
      const call =
        typeof answer === 'string' || !answer.tool
          ? undefined
          : {
              id: `call-${crypto.randomUUID()}`,
              type: 'function',
              function: { name: answer.tool, arguments: JSON.stringify(answer.input) },
            }
      const finish = call ? 'tool_calls' : 'stop'
      const streamed = typeof answer !== 'string' && 'stream' in answer ? answer : undefined
      const text = streamed ? streamed.stream.map((part) => part.text ?? '').join('') : answer
      const usage = {
        prompt_tokens: streamed?.usage?.input ?? 10,
        prompt_tokens_details:
          streamed?.usage?.cached === undefined ? undefined : { cached_tokens: streamed.usage.cached },
        completion_tokens: streamed?.usage?.output ?? 10,
        completion_tokens_details: { reasoning_tokens: streamed?.usage?.reasoning ?? 0 },
        total_tokens: (streamed?.usage?.input ?? 10) + (streamed?.usage?.output ?? 10),
      }
      const id = `chatcmpl-${crypto.randomUUID()}`
      function chunk(delta: object, finish_reason: string | null = null) {
        return {
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'echo',
          choices: [{ index: 0, delta, finish_reason }],
        }
      }
      if (!body.stream)
        return Response.json({
          id,
          object: 'chat.completion',
          created: 1,
          model: 'echo',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: call ? null : text, ...(call ? { tool_calls: [call] } : {}) },
              finish_reason: finish,
            },
          ],
          usage,
        })
      function encode(value: object) {
        return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
      }
      const stream = new ReadableStream({
        async start(controller) {
          if (streamDelay) await Bun.sleep(streamDelay)
          controller.enqueue(encode(chunk({ role: 'assistant' })))
          if (streamed) {
            for (const part of streamed.stream) {
              if (part.delay) await Bun.sleep(part.delay)
              controller.enqueue(encode(chunk({ content: part.text, reasoning_content: part.thinking })))
            }
          }
          if (call) controller.enqueue(encode(chunk({ tool_calls: [{ index: 0, ...call }] })))
          else if (!streamed) controller.enqueue(encode(chunk({ content: text })))
          controller.enqueue(encode({ ...chunk({}, finish), usage }))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  const config = {
    config: {
      content: JSON.stringify({
        model: 'ineffa-test/echo',
        command: commands,
        providers: {
          'ineffa-test': {
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'local-test-only' },
            models: {
              echo: { name: 'Local fixture', limit: { context: 128000, output: 4096 } },
              'echo-alt': { name: 'Alternative fixture', limit: { context: 128000, output: 4096 } },
            },
          },
        },
      }),
    },
    // Never fetch a model catalog from the network during an integration test.
    models: { fetch: false },
    fs: { filewatcher, fff: false },
  }
  const engine = await OpenCodeBridge.open(join(directory, 'engine'), config)
  await engine.ready(workspace)
  const store = new Store(join(directory, 'ineffa.sqlite'))
  const host = new Host(store, engine)
  await host.start()
  return {
    directory,
    workspace,
    engine,
    host,
    store,
    requests,
    server,
    config,
    async close() {
      await host.close()
      await server.stop(true)
    },
  }
}
export function human(id: string, text: string, mentions = ['A']): IncomingMessage {
  return {
    id,
    address: { id: 'channel:guild:1', title: '讨论', kind: 'channel', guildId: 'guild' },
    author: { id: 'human', name: 'user', bot: false },
    text,
    mentions,
    createdAt: Date.now(),
  }
}

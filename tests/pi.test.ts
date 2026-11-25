import { afterEach, expect, test } from 'bun:test'
import { type EngineEvent, Host, type Inbound, OpenCodeBridge, PiBridge, type PiModel, Store } from 'ineffa'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { TestAdapter, human, until } from './fixture'

type Request = {
  messages: { role: string; content: unknown }[]
  tools?: { function: { name: string; parameters: unknown } }[]
}
type Reply = string | { tool: string; input: Record<string, unknown>; callId?: string }
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function piFixture(reply: (request: Request, index: number) => Reply | Promise<Reply>) {
  const root = resolve(process.env.INEFFA_TEST_DIR ?? 'test-results/runtime')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'pi-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Request
      requests.push(body)
      const answer = await reply(body, requests.length - 1)
      const tool =
        typeof answer === 'string'
          ? undefined
          : {
              index: 0,
              id: answer.callId ?? `call_${requests.length}`,
              type: 'function',
              function: { name: answer.tool, arguments: JSON.stringify(answer.input) },
            }
      const deltas = [{ role: 'assistant' }, tool ? { tool_calls: [tool] } : { content: answer }]
      const chunks = deltas.map((delta) => ({
        id: 'test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test',
        choices: [{ index: 0, delta, finish_reason: null }],
      }))
      chunks.push({
        id: 'test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test',
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      } as never)
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  let modelAvailable = true
  const options = {
    resolveModel: async (reference: string): Promise<PiModel | undefined> =>
      modelAvailable
        ? {
            provider: 'fixture',
            id: reference.split('/')[1]!,
            baseURL: `http://127.0.0.1:${server.port}/v1`,
            apiKey: 'local-test',
            contextWindow: 128000,
            maxTokens: 1000,
          }
        : undefined,
  }
  let engine = await PiBridge.open(join(directory, 'pi'), options)
  let host: Host | undefined
  const store = new Store(join(directory, 'store.sqlite'))
  const binding = store.ensure('A', human('initial', '').address, 'build', workspace, 'pi', 'fixture/test')
  const events: EngineEvent[] = []
  let controller = new AbortController()
  let stream = (async () => {
    for await (const event of engine.events(controller.signal)) events.push(event)
  })()
  await engine.configureAccountPrompts(() => ({ system: 'Identity: Fixture', context: 'Account: A' }))
  await engine.ensure(binding)
  cleanup.push(async () => {
    controller.abort()
    await stream
    if (host) await host.close()
    else {
      await engine.close()
      store.close()
    }
    await server.stop(true)
  })
  function input(id: string, text: string): Inbound {
    return {
      id,
      bindingId: binding.id,
      message: human(id, text),
      prompt: text,
      rootId: id,
      state: 'pending',
      error: null,
      createdAt: Date.now(),
    }
  }
  return {
    get engine() {
      return engine
    },
    directory,
    workspace,
    binding,
    requests,
    events,
    input,
    store,
    async host() {
      const native = await OpenCodeBridge.open(join(directory, 'opencode'), {
        browser: false,
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
      })
      host = new Host(store, native, {}, [engine])
      await host.start()
      return host
    },
    disableModel() {
      modelAvailable = false
    },
    async restart(resume = true) {
      controller.abort()
      await stream
      await engine.close()
      engine = await PiBridge.open(join(directory, 'pi'), options)
      controller = new AbortController()
      stream = (async () => {
        for await (const event of engine.events(controller.signal)) events.push(event)
      })()
      await engine.configureAccountPrompts(() => ({ system: 'Identity: Fixture', context: 'Account: A' }))
      if (resume) await engine.ensure(binding)
    },
  }
}

test('Pi history attaches reused provider tool-call IDs to the correct assistant step', async () => {
  const f = await piFixture((_request, index) => {
    if (index === 0) return { tool: 'list_coding_tools', input: {} }
    if (index === 1 || index === 2) {
      return { tool: 'read', input: { path: `note-${index}.txt` }, callId: 'same_call_id' }
    }
    return 'done'
  })
  await Promise.all([
    writeFile(join(f.workspace, 'note-1.txt'), 'first result'),
    writeFile(join(f.workspace, 'note-2.txt'), 'second result'),
  ])
  await f.engine.submit(f.binding, f.input('notes', 'Read both files'))
  await until(() => f.events.some((event) => event.type === 'session.execution.succeeded'))
  const history = await f.engine.messages(f.binding.sessionId)
  const results = history.data.flatMap((message) =>
    message.type === 'assistant' ? message.content.filter((part) => part.type === 'tool' && part.name === 'read') : []
  )
  expect(results).toHaveLength(2)
  const reads = f.events.flatMap((event) =>
    event.type === 'session.tool.input.started' && event.data.name === 'read' ? [event.data.id] : []
  )
  expect(new Set(reads).size).toBe(2)
  expect(JSON.stringify(results[0])).toContain('second result')
  expect(JSON.stringify(results[1])).toContain('first result')
})

test('Pi uses native persistence, compact discovery and idempotent input across restart', async () => {
  const f = await piFixture((_request, index) =>
    index === 0
      ? { tool: 'list_coding_tools', input: {} }
      : index === 1
        ? { tool: 'write', input: { path: 'result.txt', content: 'native pi tool' } }
        : index === 2
          ? 'Done'
          : 'Remembered'
  )
  await writeFile(join(f.workspace, 'AGENTS.md'), 'EXTERNAL_INSTRUCTIONS_MUST_NOT_LOAD')
  const input = f.input('one', 'Write the file')
  await f.engine.submit(f.binding, input)
  await until(() => f.events.some((event) => event.type === 'session.execution.succeeded'))
  expect(await Bun.file(join(f.workspace, 'result.txt')).text()).toBe('native pi tool')
  expect(f.requests[0]!.tools!.map((tool) => tool.function.name).sort()).toEqual([
    'list_browser_tools',
    'list_coding_tools',
    'list_skills',
    'list_tools',
  ])
  expect(JSON.stringify(f.requests)).not.toContain('EXTERNAL_INSTRUCTIONS_MUST_NOT_LOAD')
  expect(JSON.stringify(f.requests[0])).toContain('Identity: Fixture')
  expect(f.requests[1]!.tools!.some((tool) => tool.function.name === 'write')).toBe(true)
  expect((await f.engine.messages(f.binding.sessionId)).data.some((message) => message.type === 'assistant')).toBe(true)
  const history = (await f.engine.messages(f.binding.sessionId)).data
  expect(history.find((message) => message.type === 'user')?.metadata).toEqual({ ineffa: { inputId: 'one' } })
  expect(history.filter((message) => message.type === 'assistant').every((message) => message.time.completed)).toBe(
    true
  )
  await f.restart()
  await f.engine.submit(f.binding, input)
  await Bun.sleep(100)
  expect(f.requests).toHaveLength(3)
  await f.engine.submit(f.binding, f.input('two', 'Continue'))
  await until(() => f.requests.length === 4)
  await until(async () => !Object.keys(await f.engine.active()).length)
  expect(JSON.stringify(f.requests[3])).toContain('Write the file')
  expect(JSON.stringify(f.requests[3])).toContain('native pi tool')
  expect(f.requests[3]!.tools!.some((tool) => tool.function.name === 'write')).toBe(true)
}, 30000)

test('Host publishes a confirmed Pi reply and keeps the original incoming message identity', async () => {
  const f = await piFixture(() => 'Pi delivered')
  const host = await f.host()
  const adapter = Object.assign(new TestAdapter('A', f.workspace), { backend: 'pi' as const, model: 'fixture/test' })
  await host.addAdapter(adapter)
  await host.receive('A', human('host-input', 'Hello Pi'))
  await until(() => adapter.sent.some((message) => message.text === 'Pi delivered'))
  const output = f.store.outputs().find((output) => output.text === 'Pi delivered')!
  expect(output.state).toBe('sent')
  expect(output.complete).toBe(true)
  expect(f.store.inbound(output.inputId!)?.message.id).toBe('host-input')
  expect(adapter.sent.filter((message) => message.kind === 'reply')).toHaveLength(1)
  expect(adapter.sent[0]!.notes?.join(' ')).toContain('tks')
}, 30000)

test('Pi sends files through the adapter callback and omits discovery calls from debug', async () => {
  const f = await piFixture((_request, index) =>
    index === 0
      ? { tool: 'list_tools', input: {} }
      : index === 1
        ? { tool: 'send_file', input: { path: 'report.txt', caption: 'Report' } }
        : 'Sent'
  )
  const sent: unknown[][] = []
  await f.engine.configureFileTool(
    () => true,
    async (...args) => {
      sent.push(args)
      return 'sent'
    }
  )
  f.engine.debug.enabled = () => true
  await f.engine.submit(f.binding, f.input('file', 'Send the report'))
  await f.engine.submit(f.binding, f.input('next', 'One more reply'))
  await until(() => f.events.filter((event) => event.type === 'session.execution.succeeded').length === 2)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.slice(3)).toEqual(['report.txt', 'Report'])
  expect(await f.engine.inputForAssistant(f.binding.sessionId, sent[0]![1] as string)).toBe('file')
  const reports: string[] = []
  for (const event of f.events) {
    if (event.type !== 'session.step.ended' && event.type !== 'session.step.failed') continue
    f.engine.debug.usage(event)
    if (event.data.finish === 'tool-calls') continue
    reports.push(f.engine.debug.report(f.binding.sessionId, event.created))
    f.engine.debug.finish(f.binding.sessionId, event.created)
  }
  expect(reports[0]).toContain('工具 1 次')
  expect(reports[1]).toContain('工具 0 次')
  expect(reports[0]).toMatch(/首字 \d+ ms/)
}, 30000)

test('Pi preserves queued work across shutdown without repeating an interrupted question', async () => {
  const f = await piFixture((_request, index) =>
    index === 0
      ? { tool: 'list_tools', input: {} }
      : index === 1
        ? { tool: 'question', input: { question: 'Wait here' } }
        : 'Resumed queue'
  )
  const first = f.input('running', 'Ask and wait')
  await f.engine.submit(f.binding, first)
  await until(async () => (await f.engine.listForms(f.binding.sessionId)).length)
  await expect(f.engine.cancelPending(f.binding.sessionId, first.id)).rejects.toMatchObject({
    code: 'input_not_queued',
  })
  await f.engine.submit(f.binding, f.input('queued', 'Continue after restart'))
  await f.restart()
  await until(() => f.requests.length === 3)
  await until(async () => !Object.keys(await f.engine.active()).length)
  await f.engine.submit(f.binding, first)
  await Bun.sleep(100)
  expect(f.requests).toHaveLength(3)
  expect(await f.engine.listForms(f.binding.sessionId)).toEqual([])
  expect(JSON.stringify(f.requests[2])).toContain('Continue after restart')
}, 30000)

test('Pi persists preflight failures as readable completed messages', async () => {
  const f = await piFixture(() => 'must not run')
  await f.engine.submit(f.binding, f.input('missing-file', 'Read image'), [
    {
      uri: pathToFileURL(join(f.workspace, 'missing-image.png')).href,
      mime: 'image/png',
    },
  ])
  await until(() => f.events.some((event) => event.type === 'session.step.failed'))
  const failed = f.events.find((event) => event.type === 'session.step.failed')!
  if (failed.type !== 'session.step.failed') throw new Error('Expected failed step')
  const message = await f.engine.message(f.binding.sessionId, failed.data.assistantMessageID)
  expect(message.type).toBe('assistant')
  if (message.type === 'assistant') expect(message.error?.message).toContain('ENOENT')
  expect(message.time.completed).toBeGreaterThan(0)
  expect(f.requests).toHaveLength(0)
}, 30000)

test('Pi history remains available after its model is removed', async () => {
  const f = await piFixture(() => 'Stored answer')
  await f.engine.submit(f.binding, f.input('stored', 'Keep this conversation'))
  await until(() => f.events.some((event) => event.type === 'session.execution.succeeded'))
  f.disableModel()
  await f.restart(false)
  expect((await f.engine.getSession(f.binding.sessionId)).model?.id).toBe('test')
  expect((await f.engine.messages(f.binding.sessionId)).data).toHaveLength(2)
  await f.engine.renameSession(f.binding.sessionId, 'Archived answer')
  expect((await f.engine.exportSession(f.binding.sessionId)).entries.length).toBeGreaterThan(0)
  await f.engine.removeSession(f.binding.sessionId)
  expect(f.requests).toHaveLength(1)
}, 30000)

test('Pi reports an unsupported image instead of silently discarding it', async () => {
  const f = await piFixture(() => 'must not run')
  await f.engine.submit(f.binding, f.input('image', 'Look at this'), [
    {
      uri: 'data:image/png;base64,aW1hZ2U=',
      mime: 'image/png',
    },
  ])
  await until(() => f.events.some((event) => event.type === 'session.step.failed'))
  const messages = (await f.engine.messages(f.binding.sessionId)).data
  const answer = messages.find((message) => message.type === 'assistant')
  if (answer?.type !== 'assistant') throw new Error('Expected an assistant error')
  expect(answer.error?.message).toContain('不支持图片')
  expect(f.requests).toHaveLength(0)
}, 30000)

test('Pi question waits for the native form reply and abort cancels a pending question', async () => {
  const f = await piFixture((_request, index) => {
    if (index === 0) return { tool: 'list_tools', input: {} }
    if (index === 1 || index === 3) return { tool: 'question', input: { question: 'Which one?', options: ['A', 'B'] } }
    return 'Answered'
  })
  await f.engine.submit(f.binding, f.input('question', 'Ask me'))
  await until(async () => (await f.engine.listForms(f.binding.sessionId)).length)
  const form = (await f.engine.listForms(f.binding.sessionId))[0]!
  expect(
    await f.engine.inputForAssistant(f.binding.sessionId, (form.metadata!.tool as { messageID: string }).messageID)
  ).toBe('question')
  await f.engine.replyForm(f.binding.sessionId, form.id, { answer: 'A' })
  await until(() => f.events.some((event) => event.type === 'session.execution.succeeded'))
  expect(
    f.requests[2]!.messages.some((message) => message.role === 'tool' && message.content === '{"answer":"A"}')
  ).toBe(true)
  await f.engine.submit(f.binding, f.input('abort', 'Ask again'))
  await until(async () => (await f.engine.listForms(f.binding.sessionId)).length)
  await f.engine.submit(f.binding, f.input('queued', 'Do not run this'))
  await f.engine.stop(f.binding.sessionId)
  expect(await f.engine.listForms(f.binding.sessionId)).toEqual([])
  expect(await f.engine.pending(f.binding.sessionId)).toEqual([])
  expect(f.events.some((event) => event.type === 'session.execution.interrupted')).toBe(true)
  expect(f.requests).toHaveLength(4)
}, 30000)

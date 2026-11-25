import { expect, test } from 'bun:test'

import type { EngineEvent } from '../packages/ineffa/src/engine'
import { PiDebug } from '../packages/ineffa/src/pi-debug'
import { piTransport } from '../packages/ineffa/src/pi-transport'

type FetchFunction = NonNullable<Parameters<PiDebug['wrapFetch']>[1]>
type PiModel = Parameters<ReturnType<typeof piTransport>>[0]
type TranscriptContext = Parameters<ReturnType<typeof piTransport>>[1]

function usage(
  sessionId: string,
  messageId: string,
  input = 100,
  cache = 0
): Extract<EngineEvent, { type: 'session.step.ended' | 'session.step.failed' }> {
  return {
    type: 'session.step.ended',
    created: Date.now(),
    data: {
      sessionID: sessionId,
      assistantMessageID: messageId,
      finish: 'stop',
      tokens: { input, output: 10, reasoning: 0, cache: { read: cache, write: 0 } },
    },
  }
}

function model(baseUrl: string): PiModel {
  return {
    id: 'fixture',
    name: 'Fixture',
    api: 'openai-completions',
    provider: 'fixture',
    baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

function chunk(delta: unknown, finishReason: string | null = null) {
  return {
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

test('Pi native transport measures headers and the first remote SSE before visible text', async () => {
  const originalFetch = globalThis.fetch
  const debug = new PiDebug()
  debug.enabled = (sessionId) => sessionId === 'A'
  debug.start('A')
  debug.step('A', 'answer')
  const requests: unknown[] = []
  let fetches = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      await Bun.sleep(60)
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(': heartbeat\n\n'))
            await Bun.sleep(100)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant' }))}\n`))
            await Bun.sleep(40)
            controller.enqueue(encoder.encode('\n'))
            await Bun.sleep(350)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: 'Native reply' }))}\n\n`))
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  ...chunk({}, 'stop'),
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 10,
                    total_tokens: 110,
                    prompt_tokens_details: { cached_tokens: 95 },
                  },
                })}\n\ndata: [DONE]\n\n`
              )
            )
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'x-fixture': 'preserved' } }
      )
    },
  })
  const customFetch = Object.assign(async (...args: Parameters<FetchFunction>) => {
    fetches++
    return originalFetch(...args)
  }, originalFetch)
  try {
    const stream = piTransport(debug, 'A')(
      model(`http://127.0.0.1:${server.port}/v1`),
      {
        messages: [
          { role: 'system', content: 'Fixture', timestamp: Date.now() },
          { role: 'user', content: 'hello', timestamp: Date.now() },
        ],
      } as TranscriptContext,
      { apiKey: 'local-fixture', fetch: customFetch, maxRetries: 0 }
    )
    const result = await stream.result()
    expect(result.stopReason).toBe('stop')
    expect(result.content).toContainEqual({ type: 'text', text: 'Native reply' })
    expect(result.usage.input).toBe(5)
    expect(result.usage.cacheRead).toBe(95)
    debug.usage(usage('A', 'answer', result.usage.input, result.usage.cacheRead))
    const report = debug.report('A', Date.now())
    const headers = [...report.split(' · 首字')[0]!.matchAll(/(\d+) ms/g)].map((match) => Number(match[1]))
    const first = Number(report.match(/首字 (\d+) ms/)?.[1])
    expect(headers).toHaveLength(3)
    expect(headers[0]).toBeGreaterThanOrEqual(40)
    expect(new Set(headers).size).toBe(1)
    expect(first).toBeGreaterThanOrEqual(headers[0]! + 100)
    expect(first).toBeLessThan(headers[0]! + 400)
    expect(report).toContain('服务排队 0s')
    expect(report).toContain('缓存命中 95.0%')
    expect(report).toContain('工具 0 次 / 0s')
    expect(fetches).toBe(1)
    expect(globalThis.fetch).toBe(originalFetch)
    expect(JSON.stringify(requests)).not.toContain('Debug')
  } finally {
    await server.stop(true)
  }
})

test('Pi header aggregates ignore compaction and other sessions while failed requests have no invented first SSE', async () => {
  const debug = new PiDebug()
  debug.enabled = (id) => id !== 'disabled'
  debug.start('A')
  debug.step('A', 'a')
  debug.start('B')
  debug.step('B', 'b')
  let calls = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const wait = Number(new URL(request.url).searchParams.get('delay')) || 0
      await Bun.sleep(wait)
      calls++
      return Response.json({ error: 'fixture rejection' }, { status: 401 })
    },
  })
  const url = `http://127.0.0.1:${server.port}/`
  try {
    await (await debug.wrapFetch('A')(`${url}?delay=40`)).text()
    await (await debug.wrapFetch('A')(`${url}?delay=120`)).text()
    debug.suspend('A', true)
    await (await debug.wrapFetch('A')(`${url}?delay=200`)).text()
    debug.suspend('A', false)
    await (await debug.wrapFetch('B')(`${url}?delay=10`)).text()
    await (await debug.wrapFetch('disabled')(url)).text()
    expect(calls).toBe(5)
    const report = debug.report('A', Date.now())
    const values = [...report.split(' · 首字')[0]!.matchAll(/(\d+) ms/g)].map((match) => Number(match[1]))
    expect(values).toHaveLength(3)
    expect(values[0]!).toBeGreaterThanOrEqual(25)
    expect(values[1]!).toBeLessThan(200)
    expect(values[2]!).toBeGreaterThan(values[0]!)
    expect(values[2]!).toBeLessThan(values[1]!)
    expect(report).toContain('首字 未采集 · 服务排队 未采集')
    expect(report).toContain('HTTP 401')
    expect(report).toContain('缓存命中 —')
    expect(debug.report('disabled', Date.now())).toBe('')
  } finally {
    await server.stop(true)
  }
})

test('Pi retains separate turn statistics for delayed journal readers and counts duplicate usage once', async () => {
  const debug = new PiDebug()
  debug.enabled = () => true
  debug.start('A')
  debug.step('A', 'old-answer')
  debug.tool('A', 'old-tool', false)
  debug.tool('A', 'old-tool', true)
  const oldUsage = usage('A', 'old-answer', 5, 95)
  debug.step('A', 'old-second-step')
  const oldSecondUsage = usage('A', 'old-second-step')
  debug.start('A')
  debug.step('A', 'new-answer')
  const newUsage = usage('A', 'new-answer')
  debug.usage(oldUsage)
  debug.usage(oldSecondUsage)
  debug.usage(oldUsage)
  const oldReport = debug.report('A', oldUsage.created)
  expect(oldReport).toContain('工具 1 次')
  expect(oldReport).toContain('缓存命中 47.5%')
  debug.finish('A', oldUsage.created)
  debug.usage(newUsage)
  const newReport = debug.report('A', newUsage.created)
  expect(newReport).toContain('工具 0 次')
  expect(newReport).toContain('缓存命中 —')
  debug.finish('A', newUsage.created)
  expect(debug.report('A', Date.now())).toBe('')
})

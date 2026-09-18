import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store } from 'ineffa'
import { join } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

import { debugDuration } from '../packages/ineffa/src/debug'
import { AccountsConfig } from '../src/config'
import { createServer } from '../src/server'

test('debug measures the first remote SSE before thinking/tools/text and stays out of model context', async () => {
  let calls = 0
  const f = await fixture(
    async () => {
      await Bun.sleep(80)
      calls++
      if (calls === 1)
        return {
          stream: [],
          tool: 'list_coding_tools',
          input: {},
          usage: { output: 0, reasoning: 0, input: 0, cached: 0 },
        }
      if (calls === 2)
        return {
          stream: [{ thinking: 'Delayed reasoning', delay: 1500 }],
          tool: 'write',
          input: { path: 'debug.txt', content: 'DONE' },
          usage: { output: 10, reasoning: 0, input: 100, cached: 80 },
        }
      return {
        stream: [{ text: 'TIMED_REPLY' }],
        usage: { output: 10, reasoning: 0, input: 300, cached: calls === 3 ? 180 : undefined },
      }
    },
    {},
    120
  )
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  try {
    const adapter = new TestAdapter('A', f.workspace)
    adapter.agentPrompt = { identity: 'ACCOUNT_PROMPT_MARKER', task: '' }
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('debug-on', '@A /debug on'))
    expect(f.requests).toHaveLength(0)
    const binding = f.store.current('A', 'channel:guild:1')!
    expect(binding.debug).toBe(true)
    await f.host.receive('A', human('timed', 'write a file'))
    await until(() => adapter.sent.some((item) => item.text.startsWith('TIMED_REPLY')))
    const output = adapter.sent.find((item) => item.text.startsWith('TIMED_REPLY'))!.notes!.at(-1)!
    expect(output).toContain('Debug ·')
    expect(output).toContain('工具 1 次')
    // (80 + 180) / (100 + 300), not the unweighted mean of 80% and 60%.
    expect(output).toContain('缓存命中 65.0%')
    const headers = [...output.split(' · 首字')[0]!.matchAll(/(\d+) ms/g)].map((item) => Number(item[1]))
    const first = [...output.matchAll(/首字 (\d+) ms/g)].map((item) => Number(item[1]))
    expect(headers).toHaveLength(3)
    expect(headers.every((value) => value >= 60)).toBe(true)
    expect(headers[0]!).toBeLessThanOrEqual(headers[2]!)
    expect(headers[2]!).toBeLessThanOrEqual(headers[1]!)
    expect(first).toHaveLength(1)
    expect(first[0]).toBeGreaterThanOrEqual(160)
    // The initial role SSE arrives before the deliberately delayed reasoning and tool call.
    expect(first[0]).toBeLessThan(1500)
    expect(output).toMatch(/服务排队 [01]s ·/)
    expect(output).toMatch(/总计 (?:\d+h )?(?:\d+m )?\d+s ·/)
    expect(output).toMatch(/工具 1 次 \/ (?:\d+h )?(?:\d+m )?\d+s/)
    expect(JSON.stringify(f.requests)).toContain('ACCOUNT_PROMPT_MARKER')
    expect(JSON.stringify(f.requests)).not.toContain('> Debug ·')
    const raw = f.store.outputs().find((item) => item.text === 'TIMED_REPLY')!
    expect(raw).toBeDefined()
    const report = f.store.debugReport(raw.sourceId)
    expect(report).toContain('连接/响应头')
    const detail = await (await fetch(`http://127.0.0.1:${app.server.port}/api/sessions/${binding.id}`)).json()
    expect(detail.messages.find((item: { id: string }) => item.id === raw.sourceId).text).toContain('> Debug ·')
    expect((await f.engine.message(binding.sessionId, raw.sourceId)).type).toBe('assistant')
    expect(JSON.stringify(await f.engine.message(binding.sessionId, raw.sourceId))).not.toContain('> Debug ·')

    await f.host.receive('A', human('timed-again', 'reply without tools'))
    await until(() => adapter.sent.filter((item) => item.text.startsWith('TIMED_REPLY')).length === 2)
    const second = adapter.sent
      .filter((item) => item.text.startsWith('TIMED_REPLY'))
      .at(-1)!
      .notes!.at(-1)!
    const secondHeaders = second.split(' · 首字')[0]!.match(/\d+ ms/g)!
    expect(secondHeaders).toHaveLength(3)
    expect(new Set(secondHeaders).size).toBe(1)
    expect(second).toContain('工具 0 次')
    expect(second).toContain('缓存命中 —')
    expect(JSON.stringify(f.requests)).not.toContain('> Debug ·')

    await f.host.receive('A', human('debug-off', '/debug off'))
    await f.host.receive('A', human('plain', 'continue'))
    await until(() => adapter.sent.filter((item) => item.text.startsWith('TIMED_REPLY')).length === 3)
    expect(adapter.sent.filter((item) => item.text.startsWith('TIMED_REPLY')).at(-1)?.text).toBe('TIMED_REPLY')
    expect(f.store.current('A', binding.address.id)?.debug).toBe(false)
    // Redelivery of an old on command must not switch the mode back on.
    await f.host.receive('A', human('debug-on', '@A /debug on'))
    expect(f.store.current('A', binding.address.id)?.debug).toBe(false)
    await expect(f.host.receive('A', human('bad-debug', '/debug maybe'))).rejects.toThrow('/debug on')
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

test('debug reports failed requests honestly and resets totals for the next turn', async () => {
  const f = await fixture(() => 'RECOVERED')
  try {
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('on-error', '/debug on'))
    f.server.reload({ fetch: () => Response.json({ error: { message: 'AUTH_FAILED' } }, { status: 401 }) })
    await f.host.receive('A', human('failure', 'hello'))
    await until(() => adapter.sent.some((item) => item.text.includes('AUTH_FAILED')))
    const reply = adapter.sent.find((item) => item.text.includes('AUTH_FAILED'))!.notes!.at(-1)!
    expect(reply).toContain('HTTP 401')
    expect(reply).toContain('首字 未采集')
    expect(reply).toContain('服务排队 未采集')
    expect(reply).toContain('工具 0 次')
    expect(reply).toContain('缓存命中 —')
    const binding = f.store.current('A', 'channel:guild:1')!
    expect(f.engine.debug.report(binding.sessionId, Date.now())).toContain('未采集')
  } finally {
    await f.close()
  }
}, 30_000)

test('debug durations use hours, minutes and seconds without wrapping at 24 hours', () => {
  expect(debugDuration(0)).toBe('0s')
  expect(debugDuration(999)).toBe('0s')
  expect(debugDuration(59_999)).toBe('59s')
  expect(debugDuration(60_000)).toBe('1m 0s')
  expect(debugDuration(3_600_000)).toBe('1h 0m 0s')
  expect(debugDuration((26 * 3600 + 11 * 60 + 1) * 1000)).toBe('26h 11m 1s')
})

test('debug stays scoped to one account, persists through restart and /new, and retains completed reports', async () => {
  const f = await fixture(() => 'REPLY')
  let restored: Host | undefined
  let closed = false
  try {
    const a = new TestAdapter('A', f.workspace)
    const b = new TestAdapter('B', f.workspace)
    await f.host.addAdapter(a)
    await f.host.addAdapter(b)
    await f.host.receive('A', human('on', '/debug on'))
    await f.host.receive('A', human('a-work', 'hello'))
    await until(() => a.sent.some((item) => item.text.startsWith('REPLY')))
    await f.host.receive('B', human('b-work', 'hello', ['B']))
    await until(() => b.sent.length === 1)
    expect(b.sent[0]?.text).toBe('REPLY')
    const original = f.store.current('A', 'channel:guild:1')!
    const message = f.store.outputs().find((item) => item.bindingId === original.id && item.text === 'REPLY')!
    const report = f.store.debugReport(message.sourceId)
    expect(report).toContain('> Debug ·')
    await f.host.close()
    closed = true
    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    restored = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    await restored.addAdapter(new TestAdapter('A', f.workspace))
    await restored.start()
    expect(restored.store.binding(original.id).debug).toBe(true)
    expect(restored.store.debugReport(message.sourceId)).toBe(report)
    const next = await restored.reset(original.id)
    expect(next.debug).toBe(true)
    expect(restored.store.debugReport(message.sourceId)).toBe(report)
  } finally {
    if (restored) await restored.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

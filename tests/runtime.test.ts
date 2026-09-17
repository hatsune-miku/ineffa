import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store } from 'ineffa'
import { join } from 'node:path'

import { TestAdapter, fixture, human, modelAccount, until } from './fixture'

test('embedded OpenCode receives input and publishes a confirmed reply', async () => {
  const f = await fixture(() => 'fixture response')
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('one', 'hello'))
    await until(() => a.sent.length > 0)
    expect(a.sent[0]?.text).toBe('fixture response')
    expect(f.requests.length).toBeGreaterThan(0)
    expect(f.store.outputs()[0]?.inputId).toBe(f.store.binding(f.store.bindings()[0]!.id).inputId)
  } finally {
    await f.close()
  }
}, 30_000)

test("B and C report asynchronously into A's original session, preserving A's intervening work", async () => {
  let releaseC!: () => void
  const cGate = new Promise<void>((resolve) => {
    releaseC = resolve
  })
  let finalContext = ''
  const f = await fixture(async (request) => {
    const last = JSON.stringify(request.messages.at(-1)?.content)
    if (modelAccount(request)?.platformId === 'B') return '@A B_DONE'
    if (modelAccount(request)?.platformId === 'C') {
      await cGate
      return '@A C_DONE'
    }
    if (last.includes('C_DONE')) {
      finalContext = JSON.stringify(request.messages)
      return 'ALL_DONE'
    }
    if (last.includes('B_DONE')) return 'Z_DONE：已完成依赖 B 的部分，等待 C。'
    return '@B 请做 X。@C 请做 Y。'
  })
  try {
    const a = new TestAdapter('A', f.workspace),
      b = new TestAdapter('B', f.workspace),
      c = new TestAdapter('C', f.workspace)
    for (const adapter of [a, b, c]) await f.host.addAdapter(adapter)
    await f.host.receive('A', human('root', '开始协作'))
    await until(() => a.sent.some((message) => message.text.includes('Z_DONE')))
    const original = f.store.current('A', 'channel:guild:1')!.sessionId
    releaseC()
    await until(() => a.sent.some((message) => message.text.includes('ALL_DONE')))
    expect(finalContext).toContain('Z_DONE')
    expect(finalContext).toContain('B_DONE')
    expect(finalContext).toContain('C_DONE')
    expect(f.store.current('A', 'channel:guild:1')!.sessionId).toBe(original)
    expect(f.store.bindings().length).toBe(3)
    expect(a.sent.length).toBe(3)
    expect(b.sent.length).toBe(1)
    expect(c.sent.length).toBe(1)
  } finally {
    releaseC()
    await f.close()
  }
}, 30_000)

test('duplicate inputs do not execute twice; queue waits for the ongoing turn', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(async (request) => {
    const last = JSON.stringify(request.messages.at(-1)?.content)
    if (last.includes('FIRST')) {
      await gate
      return 'FIRST_DONE'
    }
    return 'SECOND_DONE'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    const first = human('first', 'FIRST')
    const admitted = await f.host.receive('A', first)
    await until(() => f.requests.length === 1)
    await f.host.receive('A', first)
    await f.host.receive('A', human('second', 'SECOND'))
    const binding = f.store.bindings()[0]!
    expect(f.requests.length).toBe(1)
    expect((await f.engine.pending(binding.sessionId)).length).toBe(1)
    release()
    await until(() => a.sent.length === 2)
    expect(f.requests.length).toBe(2)
    expect(JSON.stringify(f.requests[1]!.messages)).toContain('FIRST_DONE')
    expect(f.store.outputs().filter((o) => o.inputId === admitted!.id).length).toBe(1)
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test('restart retains session history and does not replay a confirmed send', async () => {
  const f = await fixture(() => 'PERSISTED_WORK')
  let second: Host | undefined
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('before-restart', 'begin'))
    await until(() => f.store.outputs()[0]?.relayed)
    const id = f.store.bindings()[0]!.sessionId
    await f.host.close()
    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    second = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    const restored = new TestAdapter('A', f.workspace)
    await second.addAdapter(restored)
    await second.start()
    expect(second.store.bindings()[0]!.sessionId).toBe(id)
    expect(JSON.stringify(await engine.messages(id))).toContain('PERSISTED_WORK')
    await second.receive('A', human('after-restart', 'continue'))
    await until(() => restored.sent.length === 1)
    expect(f.requests.length).toBe(2)
    expect(JSON.stringify(f.requests[1]!.messages)).toContain('PERSISTED_WORK')
    expect(restored.sent.length).toBe(1)
  } finally {
    if (second) await second.close()
    else await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

test('a late report after reset stays public without waking the replacement session', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(async (request) => {
    if (modelAccount(request)?.platformId === 'C') {
      await gate
      return '@A LATE_REPORT'
    }
    return '@C START_WORK'
  })
  try {
    const a = new TestAdapter('A', f.workspace),
      c = new TestAdapter('C', f.workspace)
    await f.host.addAdapter(a)
    await f.host.addAdapter(c)
    await f.host.receive('A', human('late-root', 'delegate'))
    await until(() => f.requests.length === 2)
    const original = f.store.current('A', 'channel:guild:1')!
    const next = await f.host.reset(original.id)
    release()
    await until(() => f.store.outputs().some((o) => o.text.includes('LATE_REPORT') && o.relayed))
    expect(c.sent.length).toBe(1)
    expect(a.sent.length).toBe(1)
    expect(next.sessionId).not.toBe(original.sessionId)
    expect((await f.engine.messages(next.sessionId)).data.length).toBe(0)
    expect(f.requests.length).toBe(2)
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test('deleting a running session stops execution, drops its queue, and preserves other sessions', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(async () => {
    await gate
    return 'FINISHED'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    const other = await f.host.createConversation('A', { id: 'other', title: 'Keep', kind: 'direct' })
    await f.host.receive('A', human('delete-running', 'first'))
    await until(() => f.requests.length === 1)
    await f.host.receive('A', human('delete-queued', 'second'))
    const binding = f.store.current('A', 'channel:guild:1')!
    await f.host.removeConversation(binding.id)
    expect((await f.engine.native.sessions.active())[binding.sessionId]).toBeUndefined()
    await expect(f.engine.native.sessions.get({ sessionID: binding.sessionId })).rejects.toThrow()
    expect(f.store.bindings(true).map((b) => b.id)).toEqual([other.id])
    expect(f.store.pendingInputs()).toEqual([])
    expect(f.store.hasResetSince('A', binding.address.id, binding.createdAt)).toBe(true)
    expect(f.requests.length).toBe(1)
    expect(a.sent.length).toBe(0)
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test("real tool execution and its result remain in the next turn's context", async () => {
  let calls = 0
  const f = await fixture(() =>
    ++calls === 1
      ? { tool: 'write', input: { path: 'progress.txt', content: 'A_COMPLETED_THIS' } }
      : 'TOOL_WORK_FINISHED'
  )
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('tool-one', '记录已完成的工作'))
    await until(() => a.sent.filter((item) => item.kind === 'reply').length === 1)
    expect(await Bun.file(join(f.workspace, 'progress.txt')).text()).toBe('A_COMPLETED_THIS')
    await f.host.receive('A', human('tool-two', '继续之前的工作'))
    await until(() => a.sent.filter((item) => item.kind === 'reply').length === 2)
    expect(f.requests[2]?.messages.some((m) => m.role === 'tool')).toBe(true)
    expect(JSON.stringify(f.requests[2]?.messages)).toContain('A_COMPLETED_THIS')
    expect(calls).toBe(3)
  } finally {
    await f.close()
  }
}, 30_000)

test('model failures are visible to the originating platform', async () => {
  const f = await fixture(() => 'unused')
  f.server.reload({
    fetch: () =>
      Response.json({ error: { message: 'INVALID_TEST_KEY', type: 'authentication_error' } }, { status: 401 }),
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('bad-key', 'hello'))
    await until(() => a.sent.length > 0)
    expect(a.sent[0]?.text).toContain('INVALID_TEST_KEY')
  } finally {
    await f.close()
  }
}, 30_000)

test('stop interrupts generation and clears queued input', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(async () => {
    await gate
    return 'FINISHED'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('running', 'first'))
    await until(() => f.requests.length === 1)
    await f.host.receive('A', human('queued', 'second'))
    const binding = f.store.bindings()[0]!
    await f.host.stop(binding.id)
    expect((await f.engine.pending(binding.sessionId)).length).toBe(0)
    await until(async () => !(await f.engine.native.sessions.active())[binding.sessionId])
    expect(f.requests.length).toBe(1)
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test('the same platform identity cannot route through two account instances', async () => {
  const f = await fixture(() => 'unused')
  try {
    const a = new TestAdapter('A', f.workspace),
      duplicate = new TestAdapter('duplicate', f.workspace)
    Object.defineProperty(duplicate, 'identity', { value: { id: 'A', name: 'same bot' } })
    await f.host.addAdapter(a)
    await f.host.addAdapter(duplicate)
    expect(f.host.statuses.get('duplicate')?.state).toBe('error')
    await expect(f.host.receive('duplicate', human('duplicate-bot', 'hello'))).rejects.toThrow('另一个账号实例')
    expect(f.store.bindings().length).toBe(0)
  } finally {
    await f.close()
  }
}, 30_000)

test('reset releases the old OpenCode event subscription', async () => {
  const f = await fixture(() => 'unused')
  let streams = 0
  const log = f.engine.log.bind(f.engine)
  f.engine.log = async function* watchSession(binding, signal) {
    streams++
    try {
      yield* log(binding, signal)
    } finally {
      streams--
    }
  }
  try {
    await f.host.addAdapter(new TestAdapter('A', f.workspace))
    let binding = await f.host.createConversation('A', human('a', '').address)
    for (let i = 0; i < 3; i++) binding = await f.host.reset(binding.id)
    expect(streams).toBe(1)
    await f.host.archive(binding.id)
    expect(streams).toBe(0)
  } finally {
    await f.close()
  }
}, 30_000)

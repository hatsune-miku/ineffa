import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store } from 'ineffa'
import { join } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

import { AccountsConfig } from '../src/config'
import { createServer } from '../src/server'

test('group background is ordered, attributed and consumed independently by each account', async () => {
  const f = await fixture(() => 'ANSWER')
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    const b = new TestAdapter('B', f.workspace)
    a.name = 'Assistant Alpha'
    await f.host.addAdapter(a)
    await f.host.addAdapter(b)
    const first = {
      ...human('earlier', 'EARLIER_BACKGROUND', []),
      author: { id: '101', name: '同名用户', bot: false },
      createdAt: 1000,
    }
    const second = {
      ...human('later', 'LATER_BACKGROUND', ['C']),
      author: { id: '102', name: '同名用户', bot: false },
      createdAt: 2000,
      quote: first.text,
      quoteId: first.id,
      quoteAuthor: first.author,
    }
    for (const id of ['A', 'B']) {
      await f.host.receive(id, second)
      await f.host.receive(id, first)
      await f.host.receive(id, first)
      await f.host.receive(id, human('other-command', '@C /debug on', ['C']))
      const binding = f.store.current(id, first.address.id)!
      expect(f.store.observed(binding.id)).toHaveLength(2)
      expect(await f.engine.pending(binding.sessionId)).toHaveLength(0)
      expect((await f.engine.messages(binding.sessionId)).data).toHaveLength(0)
    }
    expect(f.requests).toHaveLength(0)
    const aBinding = f.store.current('A', first.address.id)!
    const response = await fetch(`http://127.0.0.1:${app.server.port}/api/sessions/${aBinding.id}`)
    expect(response.status).toBe(200)
    const detail = (await response.json()) as { messages: { text: string; author: string }[] }
    expect(detail.messages.map((message) => message.text)).toEqual(['EARLIER_BACKGROUND', 'LATER_BACKGROUND'])
    expect(detail.messages.map((message) => message.author)).toEqual(['同名用户 · 101', '同名用户 · 102'])
    const wake = await f.host.receive('A', human('wake', 'CURRENT_QUESTION'))
    expect(wake!.prompt.indexOf('EARLIER_BACKGROUND')).toBeLessThan(wake!.prompt.indexOf('LATER_BACKGROUND'))
    expect(wake!.prompt).toContain('"displayName":"同名用户","platformId":"101","type":"用户"')
    expect(wake!.prompt).toContain('"displayName":"同名用户","platformId":"102","type":"用户"')
    expect(wake!.prompt).toContain('提及的平台 ID：["C"]')
    expect(wake!.prompt).toContain('引用：{"messageId":"earlier","author":')
    expect(wake!.prompt).toContain('本次需要回应的消息：')
    expect(wake!.prompt).not.toContain('/debug')
    await until(() => f.store.outputs().some((output) => output.inputId === wake!.id && output.relayed))
    expect(f.requests).toHaveLength(1)
    expect(JSON.stringify(f.requests[0]!.messages)).toContain('EARLIER_BACKGROUND')
    expect(b.sent).toHaveLength(0)
    const bBinding = f.store.current('B', first.address.id)!
    const bContext = f.store.observed(bBinding.id)
    expect(bContext.filter((item) => item.message.author.id === 'A')).toHaveLength(1)
    expect(bContext.find((item) => item.message.author.id === 'A')!.prompt).toContain('Assistant Alpha')
    // A streaming gateway echo must not duplicate the confirmed final message.
    await f.host.receive('B', {
      ...human('gateway-echo', 'DRAFT_SHOULD_NOT_ENTER', ['B']),
      author: { id: 'A', name: 'A', bot: true },
    })
    expect(f.store.observed(bBinding.id)).toHaveLength(bContext.length)
    const nextA = await f.host.receive('A', human('again-a', 'NEXT_A'))
    expect(nextA!.prompt).not.toContain('EARLIER_BACKGROUND')
    await until(() => f.requests.length === 2)
    // Appending another turn leaves the earlier request prefix byte-for-byte intact.
    expect(f.requests[1]!.messages.slice(0, f.requests[0]!.messages.length)).toEqual(f.requests[0]!.messages)
    const wakeB = await f.host.receive('B', human('wake-b', 'CURRENT_B', ['B']))
    expect(wakeB!.prompt).toContain('EARLIER_BACKGROUND')
    expect(wakeB!.prompt).toContain('LATER_BACKGROUND')
    expect(wakeB!.prompt).toContain('"platformId":"A","type":"Bot"')
    await until(() => f.requests.length === 3 && b.sent.length === 1)
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

test('retry submits the frozen background once and leaves later observations for the next wake', async () => {
  const f = await fixture(() => 'DONE')
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('before-failure', 'BACKGROUND_BEFORE_FAILURE', []))
    const submit = f.engine.submit.bind(f.engine)
    f.engine.submit = async () => {
      throw new Error('local admission failed')
    }
    await expect(f.host.receive('A', human('failed', 'FIRST_QUESTION'))).rejects.toThrow('local admission failed')
    const failed = f.store.failedInputs()[0]!
    await f.host.receive('A', human('after-failure', 'BACKGROUND_AFTER_FAILURE', []))
    f.engine.submit = submit
    await f.host.submitStored(failed)
    await until(() => a.sent.length === 1)
    expect(JSON.stringify(f.requests[0]!.messages)).toContain('BACKGROUND_BEFORE_FAILURE')
    expect(JSON.stringify(f.requests[0]!.messages)).not.toContain('BACKGROUND_AFTER_FAILURE')
    const next = await f.host.receive('A', human('next', 'SECOND_QUESTION'))
    expect(next!.prompt).not.toContain('BACKGROUND_BEFORE_FAILURE')
    expect(next!.prompt).toContain('BACKGROUND_AFTER_FAILURE')
    await until(() => a.sent.length === 2)
    expect(f.requests).toHaveLength(2)
  } finally {
    await f.close()
  }
}, 30_000)

test('observing during generation never enters the running inbox, and cancelling a queued wake releases its background', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = await fixture(async () => {
    if (++calls === 1) await gate
    return 'DONE'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('running', 'START'))
    await until(() => f.requests.length === 1)
    const binding = f.store.current('A', 'channel:guild:1')!
    await f.host.receive('A', human('during', 'ARRIVED_DURING_GENERATION', []))
    expect(await f.engine.pending(binding.sessionId)).toHaveLength(0)
    expect(JSON.stringify(await f.engine.messages(binding.sessionId))).not.toContain('ARRIVED_DURING_GENERATION')
    expect(f.requests).toHaveLength(1)
    const queued = await f.host.receive('A', human('queued', 'CANCEL_THIS_QUESTION'))
    expect(await f.engine.pending(binding.sessionId)).toHaveLength(1)
    expect(f.store.observed(binding.id)).toHaveLength(0)
    await f.host.receive('A', human('abort', '/abort'))
    expect(f.store.inbound(queued!.id)?.state).toBe('cancelled')
    expect(f.store.observed(binding.id)).toHaveLength(1)
    release()
    await until(async () => !(await f.engine.native.sessions.active())[binding.sessionId])
    const after = await f.host.receive('A', human('after', 'RESUME'))
    expect(after!.prompt).toContain('ARRIVED_DURING_GENERATION')
    expect(after!.prompt).not.toContain('CANCEL_THIS_QUESTION')
    await until(() => f.requests.length === 2 && a.sent.some((message) => message.text === 'DONE'))
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test('unread background survives restart while /new starts with an empty context', async () => {
  const f = await fixture(() => 'DONE')
  let restored: Host | undefined
  try {
    await f.host.addAdapter(new TestAdapter('A', f.workspace))
    const observed = await f.host.receive('A', human('persist', 'PERSISTED_BACKGROUND', []))
    const original = f.store.binding(observed!.bindingId)
    await f.host.close()
    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    restored = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    const a = new TestAdapter('A', f.workspace)
    await restored.addAdapter(a)
    await restored.start()
    expect(f.requests).toHaveLength(0)
    expect((await engine.messages(original.sessionId)).data).toHaveLength(0)
    const wake = await restored.receive('A', human('wake-after-restart', 'FIRST_QUESTION'))
    expect(wake!.prompt).toContain('PERSISTED_BACKGROUND')
    await until(() => a.sent.some((message) => message.text === 'DONE'))
    await restored.receive('A', human('discard', 'BEFORE_NEW_BACKGROUND', []))
    await restored.receive('A', human('new', '/new'))
    const next = await restored.receive('A', human('new-question', 'FRESH_QUESTION'))
    expect(next!.bindingId).not.toBe(original.id)
    expect(next!.prompt).not.toContain('BEFORE_NEW_BACKGROUND')
    await until(() => f.requests.length === 2)
    expect(JSON.stringify(f.requests[1]!.messages)).not.toContain('PERSISTED_BACKGROUND')
    expect(JSON.stringify(f.requests[1]!.messages)).not.toContain('BEFORE_NEW_BACKGROUND')
  } finally {
    if (restored) await restored.close()
    else await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

test('passive messages respect access, exclude commands and status quotes, and never let external bots auto-wake', async () => {
  const f = await fixture(() => 'DONE')
  try {
    const a = new TestAdapter('A', f.workspace)
    a.canAccess = (address?: { id: string }) => address?.id !== 'channel:guild:forbidden'
    await f.host.addAdapter(a)
    expect(
      await f.host.receive('A', {
        ...human('forbidden', 'FORBIDDEN', []),
        address: { id: 'channel:guild:forbidden', title: 'private', kind: 'channel' },
      })
    ).toBeUndefined()
    expect(f.store.bindings()).toHaveLength(0)
    await f.host.receive('A', human('help', '/help'))
    await until(() => a.sent.length === 1)
    const binding = f.store.current('A', 'channel:guild:1')!
    const notice = f.store.outputs().find((item) => item.kind === 'notice')!
    await f.host.receive('A', {
      ...human('quoted-notice', 'ORDINARY_BACKGROUND', []),
      quote: 'platform quote preview',
      quoteId: notice.messageId!,
    })
    await f.host.receive('A', {
      ...human('external', 'EXTERNAL_BOT_MESSAGE'),
      author: { id: 'external-bot', name: 'Another Bot', bot: true },
      quote: '/debug on',
    })
    await f.host.receive('A', human('other-slash', '@B /review', ['B']))
    expect(f.store.observed(binding.id)).toHaveLength(2)
    expect(f.requests).toHaveLength(0)
    const wake = await f.host.receive('A', human('wake', 'CURRENT_QUESTION'))
    expect(wake!.prompt).toContain('EXTERNAL_BOT_MESSAGE')
    expect(wake!.prompt).toContain('"platformId":"external-bot","type":"Bot"')
    expect(wake!.prompt).not.toContain('/debug')
    expect(wake!.prompt).not.toContain('/review')
    expect(wake!.prompt).not.toContain('platform quote preview')
    await until(() => f.requests.length === 1)
  } finally {
    await f.close()
  }
}, 30_000)

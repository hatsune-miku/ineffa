import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store } from 'ineffa'
import { join } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

import { slashCommand } from '../packages/ineffa/src/commands'
import { AccountsConfig } from '../src/config'
import { createServer } from '../src/server'
import { webAdapter } from '../src/web-adapter'

test('slash parsing only recognizes human commands with an optional native mention', () => {
  const adapter = new TestAdapter('A', '.')
  adapter.mention = ({ id }) => `(met)${id}(met)`
  expect(slashCommand(adapter, human('1', '(met)A(met) /new'))).toEqual({ name: 'new', arguments: '' })
  expect(slashCommand(adapter, human('2', '/team/review "src path" (met)A(met)'))).toEqual({
    name: 'team/review',
    arguments: '"src path"',
  })
  for (const text of ['`/new`', '```\n/new\n```', '> /new', '解释 /new', '\\/new']) {
    expect(slashCommand(adapter, human('3', text))).toBeUndefined()
  }
  expect(slashCommand(adapter, { ...human('4', '/new'), author: { id: 'B', name: 'B', bot: true } })).toBeUndefined()
})

test('/new keeps history and model, deduplicates concurrently, and sends following input to the new session', async () => {
  const f = await fixture(() => 'DONE')
  try {
    const a = new TestAdapter('A', f.workspace)
    const b = new TestAdapter('B', f.workspace)
    await f.host.addAdapter(a)
    await f.host.addAdapter(b)
    await f.host.receive('A', human('first', 'OLD_CONTEXT'))
    await until(() => a.sent.length === 1)
    const original = f.store.current('A', 'channel:guild:1')!
    await f.engine.native.sessions.switchModel({
      sessionID: original.sessionId,
      model: { providerID: 'ineffa-test', id: 'echo' },
    })
    const requests = f.requests.length
    const command = human('new', '@A /new')
    const [first, duplicate] = await Promise.all([f.host.receive('A', command), f.host.receive('A', command)])
    expect(first?.id).toBe(duplicate?.id)
    const next = f.store.current('A', command.address.id)!
    expect(next.id).not.toBe(original.id)
    expect(first?.bindingId).toBe(next.id)
    expect(f.store.bindings(true).filter((item) => item.adapterId === 'A')).toHaveLength(2)
    expect(f.store.binding(original.id).archivedAt).not.toBeNull()
    expect((await f.engine.messages(original.sessionId)).data.some((item) => item.type === 'user')).toBe(true)
    expect((await f.engine.native.sessions.get({ sessionID: next.sessionId })).model?.id).toBe('echo')
    expect(f.requests).toHaveLength(requests)
    await until(() => a.sent.some((item) => item.text.includes('已开启新会话')))
    expect(b.sent).toHaveLength(0)
    await f.host.receive('A', human('after', 'NEW_CONTEXT'))
    await until(() => a.sent.filter((item) => item.text === 'DONE').length === 2)
    expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain('OLD_CONTEXT')
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('NEW_CONTEXT')
    await f.host.receive('A', command)
    expect(f.store.current('A', command.address.id)!.id).toBe(next.id)
    expect(f.store.bindings(true).filter((item) => item.adapterId === 'A')).toHaveLength(2)
  } finally {
    await f.close()
  }
}, 30_000)

test('only local commands are accepted and neither commands nor notices enter model context', async () => {
  const f = await fixture(() => 'DONE', {
    'team/review': { template: 'REVIEW_MARKER $ARGUMENTS', description: 'Review a target' },
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    for (const name of ['review', 'init', 'team/review', 'does-not-exist'])
      await expect(f.host.receive('A', human(name, `@A /${name}`))).rejects.toThrow('不支持')
    const help = await f.host.receive('A', human('help', '/help'))
    expect(help?.prompt).toBe('')
    await until(() => a.sent.some((item) => item.text.includes('/debug on|off')))
    const notice = a.sent.at(-1)!.text
    expect(notice).not.toContain('/team/review')
    expect(f.requests).toHaveLength(0)
    await f.host.receive('A', { ...human('normal', 'hello'), quote: notice })
    await until(() => a.sent.some((item) => item.text === 'DONE'))
    expect(JSON.stringify(f.requests)).not.toContain('REVIEW_MARKER')
    expect(JSON.stringify(f.requests)).not.toContain('/help')
    expect(JSON.stringify(f.requests)).not.toContain('/debug')
  } finally {
    await f.close()
  }
}, 30_000)

test('Web /new retries through the archived URL return the same new binding and a visible notice', async () => {
  const f = await fixture(() => 'unused')
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  try {
    await f.host.addAdapter(webAdapter(f.workspace))
    const binding = await f.host.createConversation('web', { id: 'web:commands', title: 'Commands', kind: 'direct' })
    const base = `http://127.0.0.1:${app.server.port}`
    async function send(id: string) {
      return fetch(`${base}/api/sessions/${binding.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text: '/new' }),
      })
    }
    const first = await send('new-once')
    expect(first.status).toBe(202)
    const result = await first.json()
    expect(result.bindingId).not.toBe(binding.id)
    const retry = await send('new-once')
    expect(retry.status).toBe(202)
    expect((await retry.json()).bindingId).toBe(result.bindingId)
    expect((await send('different')).status).toBe(409)
    const detail = await (await fetch(`${base}/api/sessions/${result.bindingId}`)).json()
    expect(detail.messages.some((item: { text: string }) => item.text.includes('已开启新会话'))).toBe(true)
    expect(f.requests).toHaveLength(0)
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

test('/new bypasses a full queue, interrupts execution and only resets the mentioned account', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(async () => {
    await gate
    return 'OLD_REPLY'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    const b = new TestAdapter('B', f.workspace)
    await f.host.addAdapter(a)
    await f.host.addAdapter(b)
    const other = await f.host.createConversation('B', human('address', '').address)
    f.host.limits.maxPending = 1
    await f.host.receive('A', human('running', 'RUNNING'))
    await until(() => f.requests.length === 1)
    const queued = await f.host.receive('A', human('queued', 'QUEUED'))
    const previous = f.store.current('A', 'channel:guild:1')!
    await f.host.receive('A', { ...human('unmentioned', '/new'), mentions: [] })
    expect(f.store.current('A', previous.address.id)!.id).toBe(previous.id)
    await expect(f.host.receive('A', human('bad-arguments', '/new something'))).rejects.toThrow('不接受参数')
    await f.host.receive('A', human('reset-running', '/new @A'))
    expect((await f.engine.native.sessions.active())[previous.sessionId]).toBeUndefined()
    expect(await f.engine.pending(previous.sessionId)).toHaveLength(0)
    expect(f.store.inbound(queued!.id)?.state).toBe('cancelled')
    expect(f.store.current('B', previous.address.id)!.id).toBe(other.id)
    expect(f.requests).toHaveLength(1)
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test('/abort interrupts only the addressed account, clears a full queue, and deduplicates without stopping later work', async () => {
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
    const b = new TestAdapter('B', f.workspace)
    await f.host.addAdapter(a)
    await f.host.addAdapter(b)
    await f.host.receive('A', human('running-a', 'KEEP_HISTORY'))
    await f.host.receive('B', human('running-b', 'OTHER_ACCOUNT', ['B']))
    await until(() => f.requests.length === 2)
    const binding = f.store.current('A', 'channel:guild:1')!
    const other = f.store.current('B', binding.address.id)!
    f.store.setDebug(binding.id, true)
    const info = await f.engine.native.sessions.get({ sessionID: binding.sessionId })
    f.host.limits.maxPending = 1
    const queued = await f.host.receive('A', human('queued', 'MUST_NOT_RUN'))
    await expect(f.host.receive('A', human('invalid-abort', '/abort now'))).rejects.toThrow('不接受参数')
    await expect(
      f.host.receive('A', { ...human('abort-file', '/abort'), files: [{ uri: 'file:///unused' }] })
    ).rejects.toThrow('不接受参数')
    await f.host.receive('A', human('unmentioned-abort', '/abort', []))
    expect((await f.engine.native.sessions.active())[binding.sessionId]).toBeDefined()

    const command = human('abort-once', '@A /abort')
    const [first, duplicate] = await Promise.all([f.host.receive('A', command), f.host.receive('A', command)])
    expect(first?.id).toBe(duplicate?.id)
    expect(first?.prompt).toBe('')
    expect(first?.state).toBe('admitted')
    await until(async () => !(await f.engine.native.sessions.active())[binding.sessionId], 2000)
    expect((await f.engine.native.sessions.active())[other.sessionId]).toBeDefined()
    expect(await f.engine.pending(binding.sessionId)).toHaveLength(0)
    expect(f.store.inbound(queued!.id)?.state).toBe('cancelled')
    expect(f.store.current('A', binding.address.id)).toMatchObject({ id: binding.id, debug: true, archivedAt: null })
    expect((await f.engine.native.sessions.get({ sessionID: binding.sessionId })).model).toEqual(info.model)
    expect(f.requests).toHaveLength(2)

    await f.host.receive('A', human('resume', 'CONTINUE'))
    await until(() => f.requests.length === 3)
    await f.host.receive('A', command)
    expect((await f.engine.native.sessions.active())[binding.sessionId]).toBeDefined()
    release()
    await until(() => a.sent.some((item) => item.text.startsWith('FINISHED')))
    expect(a.sent.filter((item) => item.text === '已停止。')).toHaveLength(1)
    const context = JSON.stringify(f.requests.at(-1)?.messages)
    expect(context).toContain('KEEP_HISTORY')
    expect(context).not.toContain('MUST_NOT_RUN')
    expect(context).not.toContain('/abort')
    expect(context).not.toContain('已停止。')
    await f.host.receive('A', human('abort-idle', '/abort @A'))
    expect(f.requests).toHaveLength(3)
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test('/new resumes its committed replacement after restart without creating a third session', async () => {
  const f = await fixture(() => 'unused')
  let restored: Host | undefined
  let closed = false
  try {
    await f.host.addAdapter(new TestAdapter('A', f.workspace))
    const command = human('recover-new', '/new')
    const previous = await f.host.createConversation('A', command.address)
    const ensure = f.engine.ensure.bind(f.engine)
    f.engine.ensure = async (binding) => {
      if (binding.id !== previous.id) throw new Error('simulated interruption after commit')
      return ensure(binding)
    }
    await expect(f.host.receive('A', command)).rejects.toThrow('simulated interruption')
    const next = f.store.current('A', command.address.id)!
    const input = f.store.failedInputs()[0]!
    expect(input.bindingId).toBe(next.id)
    f.store.inboundState(input.id, 'pending') // Crash before the submission outcome was recorded.
    await f.host.close()
    closed = true
    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    restored = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    const adapter = new TestAdapter('A', f.workspace)
    await restored.addAdapter(adapter)
    await restored.start()
    await until(() => adapter.sent.some((item) => item.text.includes('已开启新会话')))
    expect(restored.store.inbound(input.id)?.state).toBe('admitted')
    expect(restored.store.current('A', command.address.id)!.id).toBe(next.id)
    await restored.receive('A', command)
    expect(restored.store.bindings(true)).toHaveLength(2)
    expect(f.requests).toHaveLength(0)
  } finally {
    if (restored) await restored.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

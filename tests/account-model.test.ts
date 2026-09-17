import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store, modelReference } from 'ineffa'
import { kook } from 'ineffa-kook'
import { join } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

import { AccountsConfig, validateAccount } from '../src/config'
import { createServer } from '../src/server'

test('account model references validate and preserve model IDs containing slashes', () => {
  expect(modelReference(' provider/team/model ')).toEqual({ providerID: 'provider', id: 'team/model' })
  expect(modelReference('')).toBeUndefined()
  expect(modelReference(undefined)).toBeUndefined()
  for (const value of [null, 123, {}, 'model', '/model', 'provider/', 'provider/has spaces']) {
    expect(() => modelReference(value)).toThrow('provider/model')
  }
  expect(validateAccount({ id: 'a', token: 'test', directory: '.', model: 'provider/team/model' }).model).toBe(
    'provider/team/model'
  )
})

test('account model updates preserve an in-flight generation and change the next request across active sessions', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = await fixture(async () => {
    if (++calls === 1) {
      await gate
      return { tool: 'write', input: { path: 'model-switch.txt', content: 'DONE' } }
    }
    return 'FINISHED'
  })
  const accounts = new AccountsConfig(join(f.directory, 'accounts.json'))
  const config = validateAccount({
    id: 'model-a',
    token: 'local-only-token',
    name: 'A',
    directory: f.workspace,
    channels: ['123', '456', '789'],
    model: 'ineffa-test/echo',
  })
  await accounts.add(config)
  const adapter = kook(config)
  let starts = 0
  let stops = 0
  adapter.start = async (context) => {
    starts++
    context.status({ state: 'connected' })
  }
  adapter.stop = async () => {
    stops++
  }
  adapter.send = async (message) => ({ status: 'sent', messageId: message.id })
  Object.defineProperty(adapter, 'identity', { get: () => ({ id: '100', name: 'A' }) })
  await f.host.addAdapter(adapter)
  const other = new TestAdapter('B', f.workspace)
  other.model = 'ineffa-test/echo'
  await f.host.addAdapter(other)
  const app = createServer(f.host, { directory: f.workspace, accounts, port: 0 })
  const base = `http://127.0.0.1:${app.server.port}`
  async function update(model: unknown) {
    return fetch(`${base}/api/adapters/model-a/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
  }
  try {
    const address = { id: 'channel:g:123', title: 'Active', kind: 'channel' as const }
    const active = await f.host.createConversation(adapter.id, address)
    const idle = await f.host.createConversation(adapter.id, { ...address, id: 'channel:g:456' })
    const archived = await f.host.createConversation(adapter.id, { ...address, id: 'channel:g:789' })
    await f.host.archive(archived.id)
    const unrelated = await f.host.createConversation('B', address)
    await f.host.receive(adapter.id, { ...human('first', 'write the file'), address, mentions: ['100'] })
    await until(() => f.requests.length === 1)
    expect(f.requests[0]?.model).toBe('echo')

    const response = await update('ineffa-test/echo-alt')
    expect(response.status).toBe(200)
    expect(starts).toBe(1)
    expect(stops).toBe(0)
    expect(f.requests).toHaveLength(1)
    expect((await f.engine.native.sessions.active())[active.sessionId]).toBeDefined()
    for (const binding of [active, idle]) {
      expect((await f.engine.native.sessions.get({ sessionID: binding.sessionId })).model?.id).toBe('echo-alt')
      expect(f.store.binding(binding.id).sessionId).toBe(binding.sessionId)
    }
    for (const binding of [archived, unrelated]) {
      expect((await f.engine.native.sessions.get({ sessionID: binding.sessionId })).model?.id).toBe('echo')
    }
    release()
    await until(() => f.store.outputs().some((item) => item.text === 'FINISHED'))
    expect(f.requests.map((item) => item.model)).toEqual(['echo', 'echo-alt'])
    expect(await Bun.file(join(f.workspace, 'model-switch.txt')).text()).toBe('DONE')
    expect(f.requests[1]?.messages.some((item) => item.role === 'tool')).toBe(true)

    const listed = await (await fetch(`${base}/api/adapters`)).json()
    expect(listed.adapters.find((item: { id: string }) => item.id === adapter.id).model).toBe('ineffa-test/echo-alt')
    expect(JSON.stringify(listed)).not.toContain(config.token)
    expect((await new AccountsConfig(join(f.directory, 'accounts.json')).load())[0]?.model).toBe('ineffa-test/echo-alt')
    expect((await update('ineffa-test/missing')).status).toBe(400)
    expect(accounts.get(adapter.id)?.model).toBe('ineffa-test/echo-alt')

    const override = await fetch(`${base}/api/sessions/${active.id}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'ineffa-test/echo' }),
    })
    expect(override.status).toBe(409)
    // Simulate an explicit OpenCode command choosing its own model. /new restores the account binding.
    await f.engine.native.sessions.switchModel({
      sessionID: active.sessionId,
      model: { providerID: 'ineffa-test', id: 'echo' },
    })
    const next = await f.host.reset(active.id)
    expect((await f.engine.native.sessions.get({ sessionID: next.sessionId })).model?.id).toBe('echo-alt')
    expect((await update('')).status).toBe(200)
    expect(adapter.model).toBeUndefined()
    expect((await f.engine.native.sessions.get({ sessionID: next.sessionId })).model?.id).toBe('echo-alt')
    const fresh = await f.host.createConversation(adapter.id, { ...address, id: 'channel:g:789' })
    expect((await f.engine.native.sessions.get({ sessionID: fresh.sessionId })).model?.id).not.toBe('echo-alt')
  } finally {
    release()
    await app.close()
    await f.close()
  }
}, 30_000)

test('generic adapter model bindings apply to new sessions, /new, and existing sessions after restart', async () => {
  const f = await fixture(() => 'DONE')
  let restored: Host | undefined
  let closed = false
  try {
    const adapter = new TestAdapter('A', f.workspace)
    adapter.platform = 'another-platform'
    adapter.model = 'ineffa-test/echo-alt'
    await f.host.addAdapter(adapter)
    const input = await f.host.receive('A', human('new', '/new'))
    const original = f.store.binding(input!.bindingId)
    expect((await f.engine.native.sessions.get({ sessionID: original.sessionId })).model?.id).toBe('echo-alt')
    await f.host.close()
    closed = true
    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    restored = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    const next = new TestAdapter('A', f.workspace)
    next.model = 'ineffa-test/echo'
    await restored.addAdapter(next)
    await restored.start()
    expect((await engine.native.sessions.get({ sessionID: original.sessionId })).model?.id).toBe('echo')
    expect(restored.store.binding(original.id).sessionId).toBe(original.sessionId)
  } finally {
    if (restored) await restored.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

import { expect, test } from 'bun:test'
import { OpenCodeBridge } from 'ineffa'
import { join } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

import { AccountsConfig } from '../src/config'
import { ProviderSettings, compatiblePackage, providerBaseURL } from '../src/providers'
import { createServer } from '../src/server'

test('built-in credentials can be deleted independently of a custom Agent Plan and respect model bindings', async () => {
  const f = await fixture(() => 'unused', {}, 0, true)
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  const base = `http://127.0.0.1:${app.server.port}/api`
  const id = 'openai'
  const location = { directory: f.workspace }
  async function post(path: string, data: unknown) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }
  async function catalog() {
    return (await fetch(`${base}/catalog`)).json()
  }
  try {
    expect((await f.engine.native.integration.list({ location })).data.map((item) => item.id)).toContain(id)
    for (const key of ['fixture-first-key', 'fixture-second-key']) {
      const response = await post('/integrations/key', { id, key })
      expect(await response.json()).toEqual({ ok: true })
    }
    const integration = (await f.engine.native.integration.get({ integrationID: id, location })).data!
    expect(integration.connections.filter((item) => item.type === 'credential')).toHaveLength(2)
    const initial = await catalog()
    expect(initial.integrations.find((item: { id: string }) => item.id === id)).toMatchObject({
      connected: true,
      removable: true,
    })
    expect(JSON.stringify(initial)).not.toContain('fixture-first-key')
    expect(JSON.stringify(initial)).not.toContain('fixture-second-key')
    expect(
      (
        await post('/providers', {
          id: 'volcengine-agent-plan',
          name: 'Agent Plan',
          baseURL: `http://127.0.0.1:${f.server.port}/v1`,
          key: 'fixture-agent-key',
          models: ['echo'],
        })
      ).status
    ).toBe(200)
    const model = initial.models.find((item: { provider: string }) => item.provider === id)
    expect(model).toBeDefined()
    const adapter = new TestAdapter('A', f.workspace)
    adapter.model = model.id
    await f.host.addAdapter(adapter)
    expect((await post('/integrations/delete', { id })).status).toBe(409)
    expect((await f.engine.native.integration.get({ integrationID: id, location })).data!.connections).toHaveLength(
      integration.connections.length
    )
    const binding = await f.host.createConversation('A', human('address', '').address)
    adapter.model = undefined
    expect((await post('/integrations/delete', { id })).status).toBe(409)
    await f.host.archive(binding.id)
    expect((await post('/integrations/delete', { id })).status).toBe(200)
    const after = await catalog()
    expect(after.integrations.find((item: { id: string }) => item.id === id)).toMatchObject({
      connected: false,
      removable: false,
    })
    expect(after.providers.find((item: { id: string }) => item.id === 'volcengine-agent-plan')).toMatchObject({
      hasKey: true,
      models: ['echo'],
    })
    expect(await f.engine.native.sessions.get({ sessionID: binding.sessionId })).toBeDefined()
    expect((await post('/integrations/delete', { id })).status).toBe(200)
    expect((await post('/integrations/delete', { id: 'nonexistent-integration' })).status).toBe(404)
    expect(f.requests).toHaveLength(0)
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

test('custom provider discovery uses the supplied API root and bearer key, handles errors and never follows redirects', async () => {
  const seen: { path: string; key: string | null }[] = []
  let status = 200
  let payload: unknown = {
    data: [{ id: 'team/model', name: 'Model' }, { id: 'team/model' }, { nope: true }, { id: '__proto__' }],
  }
  let redirected = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/redirected') redirected++
      seen.push({ path, key: request.headers.get('authorization') })
      return Response.json(payload, { status, headers: status === 302 ? { Location: '/redirected' } : {} })
    },
  })
  const settings = new ProviderSettings({} as OpenCodeBridge)
  const baseURL = `http://127.0.0.1:${server.port}/api/plan/v3/`
  try {
    expect(await settings.discover({ baseURL, key: 'local-secret' })).toEqual({
      models: [{ id: 'team/model', name: 'team/model' }],
    })
    expect(seen[0]).toEqual({ path: '/api/plan/v3/models', key: 'Bearer local-secret' })
    status = 401
    await expect(settings.discover({ baseURL, key: 'local-secret' })).rejects.toThrow('HTTP 401')
    status = 404
    await expect(settings.discover({ baseURL })).rejects.toThrow('手动填写')
    status = 302
    await expect(settings.discover({ baseURL, key: 'local-secret' })).rejects.toThrow('无法请求')
    expect(redirected).toBe(0)
    status = 200
    payload = { models: [] }
    await expect(settings.discover({ baseURL })).rejects.toThrow('data 数组')
    payload = { data: [] }
    expect(await settings.discover({ baseURL })).toEqual({ models: [] })
    const aborted = AbortSignal.abort()
    await expect(settings.discover({ baseURL }, aborted)).rejects.toThrow('取消')
    for (const value of [
      'file:///etc/passwd',
      'https://user:pass@example.com',
      'https://example.com?key=secret',
      'not a url',
    ]) {
      expect(() => providerBaseURL(value)).toThrow('Base URL')
    }
  } finally {
    await server.stop(true)
  }
})

test('custom providers save into OpenCode config, hot reload, run tools, preserve config and credentials, and survive restart', async () => {
  let calls = 0
  const f = await fixture(
    () => (++calls === 1 ? { tool: 'write', input: { path: 'provider.txt', content: 'OK' } } : 'CUSTOM_REPLY'),
    {},
    0,
    true
  )
  const path = join(f.engine.configDirectory, 'opencode.jsonc')
  await Bun.write(path, '{\n  // Keep my comment\n  "username": "unchanged"\n}\n')
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  const base = `http://127.0.0.1:${app.server.port}`
  async function post(path: string, data: unknown) {
    return fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }
  const data = {
    id: 'custom-test',
    name: 'Custom test',
    baseURL: `http://127.0.0.1:${f.server.port}/v1`,
    key: 'secret-custom-key',
    models: ['team/custom'],
  }
  let closed = false
  let restored: OpenCodeBridge | undefined
  try {
    const response = await post('/providers', data)
    expect(response.status).toBe(200)
    const saved = await response.json()
    expect(saved.restartRequired).toBe(false)
    expect(JSON.stringify(saved)).not.toContain(data.key)
    const catalog = await (await fetch(`${base}/api/catalog`)).json()
    expect(catalog.providers.find((item: { id: string }) => item.id === data.id).hasKey).toBe(true)
    expect(catalog.models.some((item: { id: string }) => item.id === 'custom-test/team/custom')).toBe(true)
    expect(JSON.stringify(catalog)).not.toContain(data.key)
    const content = await Bun.file(path).text()
    expect(content).toContain('// Keep my comment')
    expect(content).toContain('unchanged')
    expect(content).toContain(compatiblePackage)
    const adapter = new TestAdapter('A', f.workspace)
    adapter.model = 'custom-test/team/custom'
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('custom-model', 'write the file'))
    await until(() => adapter.sent.some((item) => item.text === 'CUSTOM_REPLY'))
    expect(f.requests[0]?.model).toBe('team/custom')
    expect(await Bun.file(join(f.workspace, 'provider.txt')).text()).toBe('OK')

    const changed = await post('/providers', {
      ...data,
      name: 'Changed',
      key: '',
      models: ['team/custom', 'new-model'],
    })
    expect(changed.status).toBe(200)
    expect((await changed.json()).restartRequired).toBe(false)
    expect(await Bun.file(path).text()).toContain(data.key)
    const discovered = await post('/providers/discover', { id: data.id, baseURL: data.baseURL, key: '' })
    expect(discovered.status).toBe(200)
    expect((await discovered.json()).models.map((item: { id: string }) => item.id)).toEqual(['echo', 'echo-alt'])
    expect((await post('/providers/discover', { id: data.id, baseURL: `${data.baseURL}/other` })).status).toBe(400)
    const old = await Bun.file(path).text()
    expect((await post('/providers', { ...data, id: '__proto__' })).status).toBe(400)
    expect((await post('/providers', { ...data, models: [] })).status).toBe(400)
    expect((await post('/providers', { ...data, id: 'ineffa-test' })).status).toBe(409)
    expect((await post('/providers', { ...data, key: '', baseURL: `${data.baseURL}/other` })).status).toBe(400)
    expect(await Bun.file(path).text()).toBe(old)

    await f.host.close()
    closed = true
    restored = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    await restored.ready(f.workspace)
    const models = await restored.native.model.list({ location: { directory: f.workspace } })
    expect(models.data.some((item) => item.providerID === 'custom-test' && item.id === 'new-model')).toBe(true)
  } finally {
    await app.close()
    if (restored) await restored.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 40_000)

test('deleting a configured model checks account and session usage, preserves siblings and history, and supports the last model', async () => {
  const f = await fixture(() => 'REPLY', {}, 0, true)
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  async function post(path: string, data: unknown) {
    return fetch(`http://127.0.0.1:${app.server.port}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }
  const config = {
    id: 'removable',
    name: 'Removable',
    baseURL: `http://127.0.0.1:${f.server.port}/v1`,
    key: 'keep-this-key',
    models: ['team/used', 'spare'],
  }
  try {
    expect((await post('/providers', config)).status).toBe(200)
    const adapter = new TestAdapter('A', f.workspace)
    adapter.model = 'removable/team/used'
    await f.host.addAdapter(adapter)
    const binding = await f.host.createConversation('A', human('address', '').address)
    let response = await post('/providers/delete', { id: config.id, model: 'team/used' })
    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain('账号')
    expect((await post('/providers/delete', { id: config.id })).status).toBe(409)
    // Editing the text list must enforce the same rule as the explicit delete button.
    expect((await post('/providers', { ...config, models: ['spare'] })).status).toBe(409)
    adapter.model = undefined
    response = await post('/providers/delete', { id: config.id, model: 'team/used' })
    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain('会话')

    response = await post('/providers/delete', { id: config.id, model: 'spare' })
    expect(response.status).toBe(200)
    expect((await response.json()).restartRequired).toBe(false)
    let models = await f.engine.native.model.list({ location: { directory: f.workspace } })
    expect(models.data.some((item) => item.providerID === 'removable' && item.id === 'spare')).toBe(false)
    expect(models.data.some((item) => item.providerID === 'removable' && item.id === 'team/used')).toBe(true)
    expect(models.data.some((item) => item.providerID === 'ineffa-test')).toBe(true)
    await f.host.archive(binding.id)
    response = await post('/providers/delete', { id: config.id, model: 'team/used' })
    expect(response.status).toBe(200)
    expect((await response.json()).restartRequired).toBe(false)
    const saved = await new ProviderSettings(f.engine).list()
    expect(saved.find((item) => item.id === config.id)).toMatchObject({ hasKey: true, models: [] })
    expect(await f.engine.native.sessions.get({ sessionID: binding.sessionId })).toBeDefined()
    expect(f.store.binding(binding.id).archivedAt).toBeTruthy()
    expect((await post('/providers/delete', { id: config.id, model: 'missing' })).status).toBe(404)

    response = await post('/providers/delete', { id: config.id })
    expect(response.status).toBe(200)
    expect((await response.json()).restartRequired).toBe(false)
    expect(await new ProviderSettings(f.engine).list()).toEqual([])
    expect(await Bun.file(join(f.engine.configDirectory, 'opencode.json')).text()).not.toContain(config.key)
    expect((await post('/providers/delete', { id: config.id })).status).toBe(404)
    expect((await post('/providers/delete', { id: 'ineffa-test' })).status).toBe(404)
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

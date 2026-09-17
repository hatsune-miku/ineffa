import { expect, test } from 'bun:test'
import { kook } from 'ineffa-kook'
import { join } from 'node:path'

import { fixture, until } from './fixture'

import { AccountsConfig, validateAccount } from '../src/config'
import { acquireOwnership } from '../src/ownership'
import { createServer } from '../src/server'
import { webAdapter } from '../src/web-adapter'

test('Web API authenticates, enforces origins, and operates real persistent sessions', async () => {
  const f = await fixture(() => 'WEB_REPLY')
  await f.host.addAdapter(webAdapter(f.workspace))
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
    token: 'test-secret',
  })
  const base = `http://127.0.0.1:${app.server.port}`
  function request(path: string, data?: object) {
    return fetch(base + path, {
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      method: data ? 'POST' : 'GET',
      body: data ? JSON.stringify(data) : undefined,
    })
  }
  try {
    expect((await fetch(base + '/api/sessions')).status).toBe(401)
    expect(
      (
        await fetch(base + '/api/health', {
          headers: { Origin: 'https://evil.example', Authorization: 'Bearer test-secret' },
        })
      ).status
    ).toBe(403)
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-secret' }),
    })
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('HttpOnly')
    expect(
      (await fetch(base + '/api/sessions', { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0]! } }))
        .status
    ).toBe(200)
    const catalog = await (await request('/api/catalog')).json()
    expect(catalog.agents.some((a: { id: string }) => a.id === 'build')).toBe(true)
    const created = await request('/api/sessions', { title: '工作会话', agent: 'build', model: 'ineffa-test/echo' })
    expect(created.status).toBe(201)
    const binding = await created.json()
    await f.engine.native.permission.rules({
      sessionID: binding.sessionId,
      permissions: [{ action: 'ineffa_test', resource: '*', effect: 'ask' }],
    })
    const permission = await f.engine.native.permission.create({
      sessionID: binding.sessionId,
      action: 'ineffa_test',
      resources: ['test resource'],
      save: ['test resource'],
    })
    const permissionView = await (await request(`/api/sessions/${binding.id}`)).json()
    expect(permissionView.permissions.some((p: { id: string }) => p.id === permission.id)).toBe(true)
    expect((await request(`/api/sessions/${binding.id}/permission`, { id: permission.id, reply: 'once' })).status).toBe(
      200
    )
    const form = await f.engine.native.form.create({
      sessionID: binding.sessionId,
      title: 'Choose an option',
      fields: [
        {
          key: 'choice',
          type: 'string',
          required: true,
          options: [
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ],
        },
      ],
    })
    const formView = await (await request(`/api/sessions/${binding.id}`)).json()
    expect(formView.forms.some((item: { id: string }) => item.id === form.id)).toBe(true)
    expect((await request(`/api/sessions/${binding.id}/form`, { id: form.id, answer: { choice: 'one' } })).status).toBe(
      200
    )
    expect((await request(`/api/sessions/${binding.id}/messages`, { id: 'stable-input', text: 'hello' })).status).toBe(
      202
    )
    await until(() => f.store.outputs().some((o) => o.state === 'sent'))
    const detail = await (await request(`/api/sessions/${binding.id}`)).json()
    expect(detail.messages.some((m: { text: string }) => m.text === 'WEB_REPLY')).toBe(true)
    await request(`/api/sessions/${binding.id}/rename`, { title: '已命名' })
    expect(f.store.binding(binding.id).address.title).toBe('已命名')
    const next = await (await request(`/api/sessions/${binding.id}/reset`, {})).json()
    expect(next.sessionId).not.toBe(binding.sessionId)
    expect(f.store.binding(binding.id).archivedAt).not.toBeNull()
    expect((await request(`/api/sessions/${binding.id}/messages`, { id: 'late', text: 'late' })).status).toBe(409)
    expect((await request(`/api/sessions/${binding.id}`)).status).toBe(200)
    expect((await request(`/api/sessions/${binding.id}/delete`, {})).status).toBe(200)
    expect((await request(`/api/sessions/${binding.id}`)).status).toBe(404)
    await expect(f.engine.native.sessions.get({ sessionID: binding.sessionId })).rejects.toThrow()
    expect(f.store.outputs().some((o) => o.bindingId === binding.id)).toBe(false)
    expect(f.store.db.query('SELECT 1 FROM inbound WHERE bindingId=?').get(binding.id)).toBeNull()
    const list = await (await request('/api/sessions?archived=true')).json()
    expect(list.sessions.map((s: { id: string }) => s.id)).toEqual([next.id])
    expect((await request(`/api/sessions/${next.id}`)).status).toBe(200)
    // Retrying after a crash between native deletion and local cleanup must finish successfully.
    await f.engine.native.sessions.remove({ sessionID: next.sessionId })
    expect(await (await request(`/api/sessions/${next.id}/delete`, {})).json()).toEqual({ ok: true })
    expect((await (await request('/api/sessions?archived=true')).json()).sessions).toEqual([])
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)
test('only one process can own a data directory, and clean shutdown releases ownership', async () => {
  const f = await fixture(() => 'unused')
  try {
    const release = acquireOwnership(f.directory)
    expect(() => acquireOwnership(f.directory)).toThrow('独占')
    release()
    const second = acquireOwnership(f.directory)
    second()
  } finally {
    await f.close()
  }
}, 30_000)

test('account profile API persists edits without reconnecting or exposing credentials', async () => {
  const f = await fixture(() => 'PROFILE_REPLY')
  const accounts = new AccountsConfig(join(f.directory, 'accounts.json'))
  const config = validateAccount({
    id: 'account-a',
    name: 'Initial',
    token: 'never-return-this-token',
    directory: f.workspace,
    channels: ['123'],
    guilds: ['987'],
    agentPrompt: { identity: 'OLD_PROFILE', task: 'OLD_TASK' },
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
  // Simulate an already verified platform identity without any KOOK network requests.
  Object.defineProperty(adapter, 'identity', { get: () => ({ id: '12345', name: 'Remote bot name' }) })
  await f.host.addAdapter(adapter)
  const app = createServer(f.host, { directory: f.workspace, accounts, port: 0 })
  const base = `http://127.0.0.1:${app.server.port}`
  const profile = { identity: '你是 {displayName}，账号 {platformId}。', task: 'UPDATED_TASK' }
  try {
    const binding = await f.host.createConversation(adapter.id, {
      id: 'channel:g:123',
      title: 'Channel',
      kind: 'channel',
    })
    const response = await fetch(base + '/api/adapters/account-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', agentPrompt: profile, token: '' }),
    })
    expect(response.status).toBe(200)
    expect(starts).toBe(1)
    expect(stops).toBe(0)
    expect(f.host.adapters.get(adapter.id)).toBe(adapter)
    expect(adapter.name).toBe('Updated')
    expect(adapter.agentPrompt).toEqual(profile)
    expect(f.store.binding(binding.id).sessionId).toBe(binding.sessionId)
    const listed = await (await fetch(base + '/api/adapters')).json()
    expect(listed.adapters[0].agentPrompt).toEqual(profile)
    expect(listed.adapters[0].access.guilds).toEqual(['987'])
    expect(JSON.stringify(listed)).not.toContain(config.token)
    expect((await new AccountsConfig(join(f.directory, 'accounts.json')).load())[0]?.agentPrompt).toEqual(profile)
    await f.host.receive(adapter.id, {
      id: 'after-edit',
      address: binding.address,
      author: { id: 'human', name: 'User', bot: false },
      text: 'hello',
      mentions: ['12345'],
      createdAt: Date.now(),
    })
    await until(() => f.store.outputs().some((output) => output.state === 'sent'))
    expect(JSON.stringify(f.requests[0]!.messages)).toContain('你是 Updated，账号 12345。')

    // Reconfigure through the real API while replacing only the platform connection with a local stub.
    const addAdapter = f.host.addAdapter.bind(f.host)
    f.host.addAdapter = async (next) => {
      next.start = async (context) => {
        starts++
        context.status({ state: 'connected' })
      }
      await addAdapter(next)
    }
    const accessResponse = await fetch(base + '/api/adapters/account-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guilds: ['654'] }),
    })
    expect(accessResponse.status).toBe(200)
    expect(starts).toBe(2)
    expect(stops).toBe(1)
    const replacement = f.host.adapter(adapter.id)
    expect(replacement.canAccess({ id: 'channel:654:999', guildId: '654', title: 'New', kind: 'channel' })).toBe(true)
    expect(replacement.canAccess({ id: 'channel:987:999', guildId: '987', title: 'Old', kind: 'channel' })).toBe(false)
    expect(replacement.canAccess(binding.address)).toBe(true)
    expect((await new AccountsConfig(join(f.directory, 'accounts.json')).load())[0]?.guilds).toEqual(['654'])
    const updated = await (await fetch(base + '/api/adapters')).json()
    expect(updated.adapters[0].access.guilds).toEqual(['654'])
    expect(JSON.stringify(updated)).not.toContain(config.token)
    for (const guilds of [['invalid'], [123], '987']) {
      expect(() => validateAccount({ ...config, guilds })).toThrow('数字 ID')
    }
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

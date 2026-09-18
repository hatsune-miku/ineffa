import { expect, test } from 'bun:test'
import { OpenCodeBridge } from 'ineffa'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

import { AccountsConfig } from '../src/config'
import { createServer } from '../src/server'

test('UI settings persist native MCP/agent/runtime config, preserve JSONC and run discovered MCP tools', async () => {
  let step = 0
  const f = await fixture(() => {
    if (++step === 1) return { tool: 'list_tools', input: {} }
    if (step === 2) return { tool: 'ui_test_ping', input: {} }
    return 'DONE'
  })
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
    token: 'fixture-secret',
  })
  const base = `${app.server.url}api`
  function request(path: string, data?: object) {
    return fetch(base + path, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer fixture-secret', 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    })
  }
  let restored: OpenCodeBridge | undefined
  let closed = false
  try {
    await f.host.addAdapter(new TestAdapter('A', f.workspace))
    const path = join(f.engine.configDirectory, 'opencode.jsonc')
    await writeFile(path, '{\n  // keep this comment\n  "username": "unchanged"\n}\n')
    expect((await fetch(base + '/opencode')).status).toBe(401)
    const initial = await request('/opencode')
    expect(initial.headers.get('cache-control')).toBe('no-store')
    expect((await initial.json()).agents.some((agent: { id: string }) => agent.id === 'build')).toBe(true)
    const config = {
      type: 'local',
      command: [process.execPath, resolve('tests/support/mcp-server.ts')],
      environment: { KEY: 'sensitive-fixture-value' },
    }
    const saved = await request('/opencode/mcp/save', { id: 'ui_test', config, create: true })
    expect(saved.status).toBe(200)
    await until(async () =>
      (await f.engine.native.mcp.list({ location: { directory: f.workspace } })).data.some(
        (server) => server.name === 'ui_test' && server.status.status === 'connected'
      )
    )
    await f.host.receive('A', human('mcp', 'Use the local tool'))
    await until(() => f.requests.length >= 3)
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('MCP_UI_TOOL_OK')
    expect((await request('/opencode/mcp/disconnect', { id: 'ui_test', directory: f.workspace })).status).toBe(200)
    expect((await request('/opencode/mcp/connect', { id: 'ui_test', directory: f.workspace })).status).toBe(200)
    await until(async () =>
      (await f.engine.native.mcp.list({ location: { directory: f.workspace } })).data.some(
        (server) => server.name === 'ui_test' && server.status.status === 'connected'
      )
    )
    expect((await request('/opencode/mcp/save', { id: 'ui_test', config, create: true })).status).toBe(409)
    const invalid = await request('/opencode/mcp/save', {
      id: 'invalid',
      config: { type: 'local', command: 42, environment: { KEY: 'sensitive-fixture-value' } },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain('sensitive-fixture-value')
    const disabled = { ...config, disabled: true, cwd: f.workspace }
    expect((await request('/opencode/mcp/save', { id: 'removable', config: disabled, create: true })).status).toBe(200)
    expect((await request('/opencode/mcp/delete', { id: 'removable' })).status).toBe(200)
    expect(
      (await f.engine.native.mcp.list({ location: { directory: f.workspace } })).data.some(
        (server) => server.name === 'removable'
      )
    ).toBe(false)
    expect((await request('/opencode/mcp/delete', { id: 'ineffa_browser' })).status).toBe(400)
    await f.engine.native.mcp.add({
      server: 'external',
      config: { ...disabled, type: 'local' },
      location: { directory: f.workspace },
    })
    expect((await request('/opencode/mcp/save', { id: 'external', config, create: true })).status).toBe(409)
    expect((await request('/opencode/agents/save', { id: 'build', config: {}, create: true })).status).toBe(409)
    expect((await request('/opencode/agents/delete', { id: 'build' })).status).toBe(409)
    const foreign = await fetch(base + '/opencode/runtime', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-secret',
        Origin: 'https://untrusted.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: '' }),
    })
    expect(foreign.status).toBe(403)
    expect(
      (
        await request('/opencode/agents/save', {
          id: 'helper',
          config: { description: 'UI helper', mode: 'all', steps: 12, model: '' },
        })
      ).status
    ).toBe(200)
    expect(
      (
        await request('/opencode/runtime', {
          compaction: { auto: false, keep: { tokens: 2000 } },
          skills: [],
          model: '',
        })
      ).status
    ).toBe(200)
    const content = await readFile(path, 'utf8')
    expect(content).toContain('// keep this comment')
    expect(content).toContain('"username": "unchanged"')
    expect(content).toContain('ui_test')
    expect(content).not.toContain('removable')
    expect(content).not.toContain('external')
    const modelWithVariant = { providerID: 'ineffa-test', model: 'echo', variant: 'test-variant' }
    expect((await request('/opencode/runtime', { model: modelWithVariant })).status).toBe(200)
    expect((await request('/opencode/runtime', { model: 'ineffa-test/echo' })).status).toBe(200)
    const archive = await (await request('/config/export', {})).json()
    expect(archive.opencode.model).toEqual(modelWithVariant)
    expect(archive.opencode.mcp.servers.ui_test.command).toEqual(config.command)
    const preview = await (await request('/config/preview', { archive })).json()
    expect(
      (
        await request('/config/import', {
          archive,
          revision: preview.revision,
          choices: preview.items.map((item: { key: string }) => ({
            key: item.key,
            action: item.key === 'setting:compaction' ? 'import' : 'keep',
          })),
        })
      ).status
    ).toBe(200)
    expect((await request('/opencode/runtime', { model: '' })).status).toBe(409)
    expect((await request('/config/cancel', {})).status).toBe(200)
    await app.close()
    await f.host.close()
    closed = true
    restored = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    await restored.ready(f.workspace)
    expect(
      (await restored.native.agent.list({ location: { directory: f.workspace } })).data.some(
        (agent) => agent.id === 'helper'
      )
    ).toBe(true)
    expect(
      (await restored.native.mcp.list({ location: { directory: f.workspace } })).data.some(
        (server) => server.name === 'ui_test'
      )
    ).toBe(true)
  } finally {
    await restored?.close()
    if (!closed) {
      await app.close()
      await f.host.close()
    }
    await f.server.stop(true)
  }
}, 60_000)

test('session UI controls preserve history, keep debug out of prompts, apply permissions and export native data', async () => {
  const f = await fixture(() => 'HELLO')
  const adapter = new TestAdapter('A', f.workspace)
  await f.host.addAdapter(adapter)
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  try {
    await f.host.receive('A', human('hello', 'hi'))
    await until(() => adapter.sent.length > 0)
    const binding = f.store.current('A', 'channel:guild:1')!
    const base = `${app.server.url}api/sessions/${binding.id}`
    async function post(action: string, data: object = {}) {
      return fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    }
    const before = f.requests.length
    expect((await post('debug', { enabled: true })).status).toBe(200)
    expect(f.store.binding(binding.id).debug).toBe(true)
    expect((await post('rules', { permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] })).status).toBe(
      200
    )
    expect((await f.engine.native.sessions.get({ sessionID: binding.sessionId })).permissions?.[0]?.effect).toBe('deny')
    expect((await post('agent', { agent: 'plan' })).status).toBe(200)
    expect(f.store.binding(binding.id).agent).toBe('plan')
    expect(f.requests.length).toBe(before)
    const exported = await fetch(`${base}/export`)
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-disposition')).toContain('attachment')
    expect(await exported.text()).toContain('HELLO')
    expect((await post('compact')).status).toBe(202)
    await f.engine.native.sessions.wait({ sessionID: binding.sessionId })
    expect(f.store.binding(binding.id).sessionId).toBe(binding.sessionId)
    expect((await post('rules', { permissions: [{ effect: 'invalid' }] })).status).toBe(400)
  } finally {
    await app.close()
    await f.close()
  }
}, 40_000)

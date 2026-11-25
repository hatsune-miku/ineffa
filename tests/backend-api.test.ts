import { expect, test } from 'bun:test'
import { PiBridge } from 'ineffa'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { fixture, until } from './fixture'

import { AccountsConfig } from '../src/config'
import { ProviderSettings } from '../src/providers'
import { createServer } from '../src/server'
import { webAdapter } from '../src/web-adapter'

test('Web API routes Pi sessions, models and history to the selected backend', async () => {
  const root = resolve(process.env.INEFFA_TEST_DIR ?? 'test-results/runtime')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'pi-api-'))
  let providers!: ProviderSettings
  const pi = await PiBridge.open(directory, { resolveModel: (reference) => providers.resolvePiModel(reference) })
  const f = await fixture(() => 'PI_RESPONSE', {}, 0, false, false, [pi])
  providers = new ProviderSettings(f.engine)
  await Bun.write(join(f.engine.configDirectory, 'opencode.json'), f.config.config.content)
  await f.host.addAdapter(webAdapter(f.workspace))
  const service = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  const base = `http://127.0.0.1:${service.server.port}`
  async function post(path: string, data: unknown) {
    return fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }
  try {
    const catalog = await (await fetch(`${base}/api/catalog?backend=pi`)).json()
    expect(catalog.models.some((model: { id: string }) => model.id === 'ineffa-test/echo')).toBe(true)
    expect(JSON.stringify(catalog)).not.toContain('local-test-only')
    expect((await post('/sessions', { title: 'Invalid', backend: 'pi' })).status).toBe(400)
    const response = await post('/sessions', { title: 'Pi', backend: 'pi', model: 'ineffa-test/echo' })
    expect(response.status).toBe(201)
    const binding = await response.json()
    expect(binding.backend).toBe('pi')
    expect((await post(`/sessions/${binding.id}/messages`, { id: 'first', text: 'Hello' })).status).toBe(202)
    await until(() => f.store.outputs().some((output) => output.text === 'PI_RESPONSE'))
    const detail = await (await fetch(`${base}/api/sessions/${binding.id}`)).json()
    expect(detail.info.model.id).toBe('echo')
    expect(detail.capabilities.permissions).toBe(false)
    expect(detail.messages.find((message: { role: string }) => message.role === 'user').text).toBe('Hello')
    expect(detail.messages.find((message: { role: string }) => message.role === 'assistant').completed).toBe(true)
    expect((await post(`/sessions/${binding.id}/rules`, { permissions: [] })).status).toBe(400)
    const exported = await (await fetch(`${base}/api/sessions/${binding.id}/export`)).json()
    expect(exported.backend).toBe('pi')
    expect(JSON.stringify(exported)).not.toContain('local-test-only')
    expect((await post(`/sessions/${binding.id}/model`, { model: 'ineffa-test/echo-alt' })).status).toBe(200)
    const reset = await (await post(`/sessions/${binding.id}/reset`, {})).json()
    expect(reset.backend).toBe('pi')
    expect((await pi.getSession(reset.sessionId)).model?.id).toBe('echo-alt')
    await post(`/sessions/${reset.id}/messages`, { id: 'before-switch', text: 'Keep the word cobalt.' })
    await until(() => f.store.outputs().some((output) => output.bindingId === reset.id && output.state === 'sent'))
    const requestsBeforeSwitch = f.requests.length
    const change = await post(`/sessions/${reset.id}/backend`, { backend: 'opencode', model: 'ineffa-test/echo' })
    expect(change.status, await change.clone().text()).toBe(200)
    const next = await change.json()
    expect(next.backend).toBe('opencode')
    expect(next.predecessorId).toBe(reset.id)
    expect(f.requests.length).toBe(requestsBeforeSwitch)
    const retry = await post(`/sessions/${reset.id}/backend`, { backend: 'opencode', model: 'ineffa-test/echo' })
    expect((await retry.json()).id).toBe(next.id)

    const continued = await post(`/sessions/${next.id}/messages`, { id: 'after-switch', text: 'What was the word?' })
    expect(continued.status).toBe(202)
    await until(() => f.store.outputs().some((output) => output.bindingId === next.id && output.state === 'sent'))
    const request = JSON.stringify(f.requests.at(-1)?.messages)
    expect(request).toContain('Keep the word cobalt.')
    expect(request).toContain('PI_RESPONSE')
    expect(request).toContain('What was the word?')
    const backPath = `/sessions/${next.id}/backend`
    expect((await post(backPath, {})).status).toBe(400)
    expect((await post(backPath, { backend: 'pi' })).status).toBe(400)
    const back = await post(backPath, { backend: 'pi', model: 'ineffa-test/echo-alt' })
    expect(back.status, await back.clone().text()).toBe(200)
    const returned = await back.json()
    expect(returned.predecessorId).toBe(next.id)
    expect((await pi.getSession(returned.sessionId)).model?.id).toBe('echo-alt')
    expect((await post(`/sessions/${reset.id}/delete`, {})).status).toBe(200)
  } finally {
    await service.close()
    await f.close()
  }
}, 30_000)

import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store } from 'ineffa'
import { mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

import { TestAdapter, fixture, human } from './fixture'

import { AccountsConfig, validateAccount } from '../src/config'
import {
  ConfigTransfer,
  type MergePreview,
  applyPendingImport,
  parseArchive,
  pendingImportPath,
} from '../src/config-transfer'
import { compatiblePackage } from '../src/providers'
import { createServer } from '../src/server'

test('plaintext archive merges providers, credentials and accounts across restart without touching conversations', async () => {
  const f = await fixture(() => 'unused')
  const accounts = new AccountsConfig(join(f.directory, 'accounts.json'))
  const transfer = new ConfigTransfer(f.host, accounts, f.workspace)
  let closed = false
  let restored: OpenCodeBridge | undefined
  const configPath = join(f.engine.configDirectory, 'opencode.json')
  const provider = {
    package: compatiblePackage,
    name: 'Local',
    settings: { baseURL: 'https://local.example/v1', apiKey: 'local-key' },
    models: { local: {}, shared: { name: 'old' } },
  }
  try {
    await accounts.add(
      validateAccount({ id: 'A', token: 'local-bot-token', directory: f.workspace, model: 'local/local' })
    )
    await accounts.add(validateAccount({ id: 'untouched', token: 'keep-token', directory: f.workspace }))
    await Bun.write(configPath, JSON.stringify({ providers: { local: provider }, shell: 'local-shell' }))
    await f.engine.native.integration.connect.key({
      integrationID: 'openai',
      key: 'native-plain-key',
      location: { directory: f.workspace },
    })
    await f.host.addAdapter(new TestAdapter('A', f.workspace))
    const binding = await f.host.createConversation('A', human('existing', '').address)
    const exported = await transfer.export()
    expect(exported.credentials.openai![0]!.value.key).toBe('native-plain-key')
    expect(exported.accounts[0]!.token).toBe('local-bot-token')
    expect(JSON.stringify(exported.opencode)).toContain('local-key')
    expect(exported).not.toHaveProperty('sessions')

    const incoming = structuredClone(exported)
    incoming.accounts = [
      { ...incoming.accounts[0]!, name: 'Imported', token: 'imported-bot-token', model: 'local/new' },
    ]
    incoming.accounts.push({ ...incoming.accounts[0]!, id: 'B', directory: 'C:\\source\\workspace' })
    incoming.opencode = {
      providers: {
        local: {
          ...provider,
          name: 'Imported',
          settings: { baseURL: 'https://imported.example/v1', apiKey: 'imported-key' },
          models: { new: {}, shared: { name: 'new' } },
        },
      },
      shell: 'imported-shell',
    }
    incoming.credentials.openai![0]!.value.key = 'imported-native-key'
    const preview = await transfer.preview(incoming)
    expect(preview.items.find((item) => item.key === 'account:A')?.conflict).toBe(true)
    expect(preview.items.find((item) => item.key === 'account:B')?.directory).toBe(f.workspace)
    expect(JSON.stringify(preview)).not.toContain('imported-bot-token')
    expect(JSON.stringify(preview)).not.toContain('imported-key')
    expect(JSON.stringify(preview)).not.toContain('imported-native-key')
    const missingProvider = preview.items.map((item) => ({
      key: item.key,
      action: item.kind === 'account' ? 'import' : 'keep',
      directory: item.directory,
    }))
    await expect(transfer.stage(incoming, preview.revision, missingProvider)).rejects.toThrow('同时导入')
    const choices = preview.items.map((item) => ({
      key: item.key,
      action: item.kind === 'setting' ? 'keep' : 'import',
      directory: item.directory,
    }))
    expect(await transfer.stage(incoming, preview.revision, choices)).toMatchObject({ restartRequired: true })
    expect(accounts.get('A')!.token).toBe('local-bot-token')
    expect((await transfer.export()).credentials.openai![0]!.value.key).toBe('native-plain-key')
    await expect(transfer.stage(incoming, preview.revision, choices)).rejects.toThrow('待生效')

    await f.host.close()
    closed = true
    await applyPendingImport(accounts.path, f.engine.configDirectory, f.engine.databasePath)
    const loaded = await new AccountsConfig(accounts.path).load()
    expect(loaded).toHaveLength(3)
    expect(loaded.find((a) => a.id === 'A')).toMatchObject({
      name: 'Imported',
      token: 'imported-bot-token',
      model: 'local/new',
    })
    expect(loaded.find((a) => a.id === 'B')!.directory).toBe(f.workspace)
    const config = await Bun.file(configPath).json()
    expect(config.shell).toBe('local-shell')
    expect(Object.keys(config.providers.local.models).sort()).toEqual(['local', 'new', 'shared'])
    expect(config.providers.local.models.shared.name).toBe('new')
    expect(config.providers.local.settings.apiKey).toBe('imported-key')
    expect(await Bun.file(pendingImportPath(accounts.path)).exists()).toBe(false)
    // A second startup is harmless; the same native session and imported credential survive.
    await applyPendingImport(accounts.path, f.engine.configDirectory, f.engine.databasePath)
    restored = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    await restored.ready(f.workspace)
    const connection = await restored.native.integration.get({
      integrationID: 'openai',
      location: { directory: f.workspace },
    })
    expect(connection.data?.connections.some((entry) => entry.type === 'credential')).toBe(true)
    const host = new Host(new Store(join(f.directory, 'restored.sqlite')), restored)
    const migrated = new ConfigTransfer(host, new AccountsConfig(accounts.path), f.workspace)
    expect((await migrated.export()).credentials.openai![0]!.value.key).toBe('imported-native-key')
    expect(await restored.native.sessions.get({ sessionID: binding.sessionId })).toBeDefined()
    expect(f.requests).toHaveLength(0)
    await host.close()
    restored = undefined
  } finally {
    if (restored) await restored.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

test('merge rejects malformed files, stale previews, missing decisions and changes to active account directories', async () => {
  const f = await fixture(() => 'unused')
  const accounts = new AccountsConfig(join(f.directory, 'accounts.json'))
  const transfer = new ConfigTransfer(f.host, accounts, f.workspace)
  try {
    await accounts.add(validateAccount({ id: 'A', token: 'token', directory: f.workspace }))
    await f.host.addAdapter(new TestAdapter('A', f.workspace))
    await f.host.createConversation('A', human('existing', '').address)
    const archive = await transfer.export()
    const preview = await transfer.preview(archive)
    const choices = preview.items.map((item) => ({
      key: item.key,
      action: 'import',
      directory: join(f.workspace, 'different'),
    }))
    await expect(transfer.stage(archive, preview.revision, choices)).rejects.toThrow('活跃会话')
    await expect(transfer.stage(archive, preview.revision, [])).rejects.toThrow('合并方式')
    await accounts.update({ ...accounts.get('A')!, name: 'changed' })
    await expect(transfer.stage(archive, preview.revision, choices)).rejects.toThrow('配置已变化')
    expect(await transfer.pending()).toBe(false)
    for (const value of [
      { ...archive, version: 99 },
      { ...archive, accounts: [archive.accounts[0], archive.accounts[0]] },
      { ...archive, credentials: { openai: [null] } },
      { ...archive, opencode: { providers: 5 } },
      JSON.parse('{"format":"ineffa-config","version":1,"__proto__":{}}'),
    ]) {
      expect(() => parseArchive(value)).toThrow()
    }
  } finally {
    await f.close()
  }
}, 30_000)

test('failed startup retains pending import for recovery before accounts or OpenCode run', async () => {
  const f = await fixture(() => 'unused')
  const accounts = new AccountsConfig(join(f.directory, 'accounts.json'))
  const transfer = new ConfigTransfer(f.host, accounts, f.workspace)
  let closed = false
  try {
    const archive = await transfer.export()
    archive.opencode = { shell: 'updated' }
    const preview = await transfer.preview(archive)
    await transfer.stage(archive, preview.revision, [{ key: 'setting:shell', action: 'import' }])
    await f.host.close()
    closed = true
    // Fail after the native config write, before the accounts write. Startup must not proceed.
    await mkdir(accounts.path)
    await expect(applyPendingImport(accounts.path, f.engine.configDirectory, f.engine.databasePath)).rejects.toThrow()
    expect(await transfer.pending()).toBe(true)
    await rmdir(accounts.path)
    await applyPendingImport(accounts.path, f.engine.configDirectory, f.engine.databasePath)
    expect(await transfer.pending()).toBe(false)
    expect((await Bun.file(join(f.engine.configDirectory, 'opencode.json')).json()).shell).toBe('updated')
  } finally {
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

test('configuration API requires authentication, never caches secrets, and freezes edits until restart', async () => {
  const f = await fixture(() => 'unused')
  const accounts = new AccountsConfig(join(f.directory, 'accounts.json'))
  const app = createServer(f.host, { directory: f.workspace, accounts, port: 0, token: 'test-auth' })
  const base = `http://127.0.0.1:${app.server.port}/api`
  async function post(path: string, data: unknown, token = 'test-auth', extra = {}) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra },
      body: JSON.stringify(data),
    })
  }
  try {
    expect((await post('/config/export', {}, '')).status).toBe(401)
    expect((await post('/config/export', {}, 'test-auth', { Origin: 'https://other.example' })).status).toBe(403)
    const response = await post('/config/export', {})
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    const archive = await response.json()
    archive.opencode = { shell: 'updated' }
    const preview = (await (await post('/config/preview', { archive })).json()) as MergePreview
    const result = await post('/config/import', {
      archive,
      revision: preview.revision,
      choices: [{ key: 'setting:shell', action: 'import' }],
    })
    expect(result.status).toBe(200)
    expect((await post('/integrations/key', { id: 'openai', key: 'should-not-save' })).status).toBe(409)
    expect((await post('/adapters', { id: 'B' })).status).toBe(409)
    const status = await fetch(base + '/config/status', { headers: { Authorization: 'Bearer test-auth' } })
    expect(await status.json()).toEqual({ pending: true })
    expect((await post('/config/cancel', {})).status).toBe(200)
    expect((await post('/integrations/key', { id: 'openai', key: 'can-save-again' })).status).toBe(200)
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

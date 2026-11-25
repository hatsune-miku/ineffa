import { expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { AccountsConfig, accountAdapter, validateAccount } from '../src/config'
import { parseArchive } from '../src/config-transfer'

test('legacy KOOK accounts retain their backend and Lark account settings round-trip without losing secrets', async () => {
  const root = resolve(process.env.INEFFA_TEST_DIR ?? 'test-results/runtime')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'accounts-'))
  const path = join(directory, 'accounts.json')
  await Bun.write(path, JSON.stringify([{ id: 'legacy', token: 'test-kook-token', directory }]))
  const accounts = new AccountsConfig(path)
  const legacy = (await accounts.load())[0]!
  expect(legacy.platform).toBe('kook')
  expect(legacy.backend).toBe('opencode')
  const incoming = validateAccount({
    id: 'lark-account',
    platform: 'lark',
    backend: 'pi',
    domain: 'feishu',
    appId: 'cli_0123456789abcdef',
    appSecret: 'local-only-secret',
    model: 'compatible/team/model',
    chats: ['oc_example'],
    users: ['ou_example'],
    directory,
  })
  await accounts.add(incoming)
  expect(await new AccountsConfig(path).load()).toEqual([legacy, incoming])
  const archive = parseArchive({
    format: 'ineffa-config',
    version: 1,
    accounts: accounts.list(),
    opencode: {},
    credentials: {},
  })
  expect(archive.accounts[1]).toEqual(incoming)
  const adapter = accountAdapter(incoming)
  expect(adapter.platform).toBe('feishu')
  expect(adapter.backend).toBe('pi')
  expect(adapter.canAccess({ id: 'channel:oc_example', kind: 'channel', title: 'Test' })).toBe(true)
})

test('platform and backend validation rejects unusable combinations before saving', () => {
  const base = { id: 'account', token: 'test', directory: '.' }
  expect(() => validateAccount({ ...base, backend: 'unknown' })).toThrow('后端')
  expect(() => validateAccount({ ...base, platform: 'unknown' })).toThrow('平台')
  expect(() => validateAccount({ ...base, backend: 'pi' })).toThrow('绑定模型')
  expect(() => validateAccount({ ...base, platform: 'lark', appId: 'cli_bad', appSecret: 'test' })).toThrow('App ID')
  expect(() =>
    validateAccount({
      ...base,
      platform: 'lark',
      appId: 'cli_0123456789abcdef',
      appSecret: 'test',
      chats: ['123'],
    })
  ).toThrow('平台 ID')
})

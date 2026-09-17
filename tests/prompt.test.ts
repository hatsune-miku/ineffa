import { expect, test } from 'bun:test'
import { validateAgentPrompt } from 'ineffa'
import { kook } from 'ineffa-kook'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TestAdapter, fixture, human, modelAccount, systemText, until } from './fixture'

import { expandPrompt } from '../packages/ineffa/src/prompt'
import { AccountsConfig, validateAccount } from '../src/config'

test('account prompts persist as templates, validate text, and expand only documented macros once', async () => {
  const adapter = new TestAdapter('local-account', '.')
  adapter.platformId = '10001'
  adapter.name = 'Name {platformId}'
  expect(expandPrompt('{displayName} / {platformId} / {unknown}', adapter)).toBe(
    'Name {platformId} / 10001 / {unknown}'
  )
  expect(validateAgentPrompt({ identity: ' ', task: '' })).toBeUndefined()
  expect(() => validateAgentPrompt({ identity: 123 })).toThrow()
  expect(() => validateAgentPrompt({ task: 'a'.repeat(16001) })).toThrow()
  expect(() =>
    kook({ id: 'bad', token: 'test', directory: '.', agentPrompt: { identity: 123, task: '' } as never })
  ).toThrow()

  const f = await fixture(() => 'unused')
  try {
    const path = join(f.directory, 'accounts.json')
    const accounts = new AccountsConfig(path)
    const profile = { identity: '你是 {displayName}。', task: '使用账号 {platformId} 处理任务。' }
    const config = validateAccount({
      id: 'local-account',
      name: '助理',
      token: 'test',
      directory: f.workspace,
      agentPrompt: profile,
    })
    await accounts.add(config)
    const restored = await new AccountsConfig(path).load()
    expect(restored[0]?.agentPrompt).toEqual(profile)
    expect(kook(restored[0]!).agentPrompt).toEqual(profile)
    await accounts.update(validateAccount({ ...config, agentPrompt: { identity: '', task: '' } }))
    expect((await new AccountsConfig(path).load())[0]?.agentPrompt).toBeUndefined()
  } finally {
    await f.close()
  }
}, 30_000)

test('per-account prompts exclude external instructions, isolate scopes, and see peers before their first message', async () => {
  const f = await fixture(() => 'DONE')
  try {
    await writeFile(join(f.workspace, 'AGENTS.md'), 'PROJECT_GUIDANCE_TO_IGNORE')
    const a = new TestAdapter('A', f.workspace)
    a.name = '研究员'
    a.platformId = '10001'
    a.agentPrompt = { identity: '你是 {displayName}，账号 {platformId}。', task: 'A_PRIVATE_TASK' }
    const b = new TestAdapter('B', f.workspace)
    b.name = '审阅员'
    b.platformId = '10002'
    b.agentPrompt = { identity: '你是 {displayName}，账号 {platformId}。', task: 'B_PRIVATE_TASK' }
    const otherRoom = new TestAdapter('C', f.workspace)
    otherRoom.conversationKey = () => 'a-different-room'
    const otherPlatform = new TestAdapter('D', f.workspace)
    otherPlatform.platform = 'other-platform'
    const denied = new TestAdapter('E', f.workspace)
    denied.canAccess = () => false
    const privateAccount = new TestAdapter('F', f.workspace)
    privateAccount.conversationKey = () => undefined
    for (const adapter of [a, b, otherRoom, otherPlatform, denied, privateAccount]) await f.host.addAdapter(adapter)

    expect(f.store.current('B', human('', '').address.id)).toBeUndefined()
    const input = await f.host.receive('A', human('a', 'USER_TASK', ['10001']))
    await until(() => a.sent.length === 1)
    const system = systemText(f.requests[0]!)
    expect(system).toStartWith('Agent 身份：\n你是 研究员，账号 10001。')
    expect(system).toContain('A_PRIVATE_TASK')
    expect(JSON.stringify(f.requests[0])).not.toContain('PROJECT_GUIDANCE_TO_IGNORE')
    expect(system).toContain('"displayName":"审阅员","platformId":"10002"')
    expect(system).not.toContain('B_PRIVATE_TASK')
    for (const id of ['C', 'D', 'E', 'F']) expect(system).not.toContain(`"platformId":"${id}"`)
    expect(f.requests).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
    expect(f.requests[0]!.tools).toBeDefined()
    expect(input?.prompt).not.toContain('A_PRIVATE_TASK')

    await f.host.receive('B', human('b', 'USER_TASK', ['10002']))
    await until(() => b.sent.length === 1)
    expect(modelAccount(f.requests[1]!)).toMatchObject({ displayName: '审阅员', platformId: '10002' })
    expect(systemText(f.requests[1]!)).toContain('"displayName":"研究员","platformId":"10001"')
    expect(systemText(f.requests[1]!)).not.toContain('A_PRIVATE_TASK')

    await f.host.receive('A', { ...human('private', 'DM'), address: { id: 'dm:user', title: 'DM', kind: 'direct' } })
    await until(() => a.sent.length === 2)
    expect(systemText(f.requests[2]!)).toContain('A_PRIVATE_TASK')
    expect(systemText(f.requests[2]!)).not.toContain('10002')
    expect(f.requests).toHaveLength(3)
  } finally {
    await f.close()
  }
}, 30_000)

test('profile and peer changes apply on tool continuation without resetting history or extra model requests', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = await fixture(async () => {
    if (++calls === 1) {
      await gate
      return { tool: 'list_coding_tools', input: {} }
    }
    if (calls === 2) return { tool: 'write', input: { path: 'progress.txt', content: 'WORK_TO_KEEP' } }
    return 'DONE'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    a.agentPrompt = { identity: 'IDENTITY_OLD {displayName}', task: 'TASK_OLD' }
    const b = new TestAdapter('B', f.workspace)
    await f.host.addAdapter(a)
    await f.host.addAdapter(b)
    await f.host.receive('A', human('start', 'USER_TASK'))
    await until(() => calls === 1)
    const session = f.store.current('A', human('', '').address.id)!.sessionId
    a.name = 'Renamed'
    a.agentPrompt = { identity: 'IDENTITY_NEW {displayName}', task: 'TASK_NEW {platformId}' }
    await f.host.removeAdapter('B')
    release()
    await until(() => a.sent.filter((item) => item.kind === 'reply').length === 1)
    const system = systemText(f.requests[1]!)
    expect(system).toContain('IDENTITY_NEW Renamed')
    expect(system).toContain('TASK_NEW A')
    expect(system).not.toContain('IDENTITY_OLD')
    expect(system).not.toContain('"platformId":"B"')
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('WORK_TO_KEEP')
    expect(f.store.current('A', human('', '').address.id)!.sessionId).toBe(session)
    expect(f.requests).toHaveLength(3)

    a.agentPrompt = undefined
    await f.host.receive('A', human('clear', 'CONTINUE'))
    await until(() => a.sent.filter((item) => item.kind === 'reply').length === 2)
    expect(systemText(f.requests[3]!)).not.toContain('IDENTITY_NEW')
    expect(systemText(f.requests[3]!)).toContain('当前平台账号：')
  } finally {
    release()
    await f.close()
  }
}, 30_000)

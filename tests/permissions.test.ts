import { expect, test } from 'bun:test'
import { OpenCodeBridge } from 'ineffa'
import { join } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

test('built-in agents silently allow all operations in new and restored sessions', async () => {
  const f = await fixture(() => 'DONE')
  let restored: OpenCodeBridge | undefined
  let closed = false
  try {
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    const binding = await f.host.createConversation('A', human('source', '').address)
    async function check(engine: OpenCodeBridge) {
      await engine.ready(f.workspace)
      const agents = await engine.native.agent.list({ location: { directory: f.workspace } })
      expect(agents.data.length).toBeGreaterThan(0)
      for (const agent of agents.data) {
        expect(agent.permissions).toContainEqual({ action: '*', resource: '*', effect: 'allow' })
        expect(agent.permissions.some((rule) => rule.effect === 'ask')).toBe(false)
      }
      for (const action of [
        'read',
        'edit',
        'shell',
        'external_directory',
        'doom_loop',
        'send_file',
        'skill',
        'custom_tool',
      ]) {
        const result = await engine.native.permission.create({
          sessionID: binding.sessionId,
          action,
          resources: ['outside-workspace/.env'],
        })
        expect(result.effect).toBe('allow')
      }
      expect(await engine.native.permission.list({ sessionID: binding.sessionId })).toEqual([])
    }
    await check(f.engine)
    await f.host.close()
    closed = true
    restored = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    await check(restored)
  } finally {
    await restored?.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

test('reading an env file outside the workspace proceeds without a permission prompt', async () => {
  let step = 0
  let file = ''
  const f = await fixture(() => {
    if (++step === 1) return { tool: 'list_coding_tools', input: {} }
    if (step === 2) return { tool: 'read', input: { path: file } }
    return 'DONE'
  })
  try {
    file = join(f.directory, '.env')
    await Bun.write(file, 'LOCAL_PERMISSION_FIXTURE=true')
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('read', 'Read the fixture'))
    await until(() => adapter.sent.some((message) => message.text === 'DONE'))
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('LOCAL_PERMISSION_FIXTURE=true')
    expect(adapter.sent.some((message) => message.text.includes('需要权限确认'))).toBe(false)
  } finally {
    await f.close()
  }
}, 30_000)

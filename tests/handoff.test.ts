import { expect, spyOn, test } from 'bun:test'
import { type Binding, type Inbound, IneffaError, PiBridge, Store } from 'ineffa'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { type ModelReply, TestAdapter, fixture, human, until } from './fixture'

import { boundHandoff } from '../packages/ineffa/src/handoff'

async function handoffFixture(reply: (index: number) => ModelReply | Promise<ModelReply>) {
  const root = resolve(process.env.INEFFA_TEST_DIR ?? 'test-results/runtime')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'handoff-'))
  let current: Awaited<ReturnType<typeof fixture>>
  const pi = await PiBridge.open(join(directory, 'pi'), {
    resolveModel: async (reference) => ({
      provider: reference.slice(0, reference.indexOf('/')),
      id: reference.slice(reference.indexOf('/') + 1),
      baseURL: `http://127.0.0.1:${current.server.port}/v1`,
      apiKey: 'local-test',
    }),
  })
  let requests = 0
  current = await fixture(() => reply(requests++), {}, 0, false, false, [pi])
  const adapter = new TestAdapter('A', current.workspace)
  await current.host.addAdapter(adapter)
  return { ...current, adapter, pi }
}

async function switchSettled(
  f: Awaited<ReturnType<typeof handoffFixture>>,
  binding: Binding,
  backend: 'opencode' | 'pi'
) {
  const started = Date.now()
  while (true) {
    try {
      return await f.host.switchBackend(binding.id, backend, 'ineffa-test/echo')
    } catch (error) {
      if (
        !(error instanceof IneffaError) ||
        !['session_settling', 'handoff_pending_delivery'].includes(error.code) ||
        Date.now() - started > 5000
      )
        throw error
      await Bun.sleep(20)
    }
  }
}

test('handoff transfers visible work once, flattens repeated hops and preserves unread group messages', async () => {
  const f = await handoffFixture((index) => {
    if (index === 0) return { tool: 'list_coding_tools', input: {} }
    if (index === 1) return { tool: 'write', input: { path: 'completed.txt', content: 'EXISTING_WORK' } }
    if (index === 2) return { stream: [{ thinking: 'PRIVATE_REASONING' }, { text: 'SOURCE_COMPLETE' }] }
    return 'CONTINUED'
  })
  try {
    await f.host.receive('A', human('background', 'CONSUMED_BACKGROUND', []))
    await f.host.receive('A', human('debug', '/debug on'))
    const input = await f.host.receive('A', human('start', 'ORIGINAL_REQUEST'))
    const old = f.store.binding(input!.bindingId)
    await until(() => f.store.outputs().some((item) => item.text === 'SOURCE_COMPLETE' && item.relayed))
    await f.host.receive('A', {
      ...human('unread', 'UNREAD_BACKGROUND', []),
      files: [{ uri: pathToFileURL(join(f.workspace, 'completed.txt')).href, name: 'report.txt' }],
    })
    const first = await switchSettled(f, old, 'pi')
    expect(first.predecessorId).toBe(old.id)
    expect(f.requests).toHaveLength(3)
    expect(f.store.binding(old.id).archivedAt).not.toBeNull()
    expect((await f.host.switchBackend(old.id, 'pi', 'ineffa-test/echo')).id).toBe(first.id)
    expect(f.store.observed(first.id)).toHaveLength(1)
    expect(f.store.observed(first.id)[0]!.message.files?.[0]!.name).toBe('report.txt')
    const snapshot = JSON.stringify(f.store.handoff(first.id))
    expect(snapshot).toContain('ORIGINAL_REQUEST')
    expect(snapshot).toContain('CONSUMED_BACKGROUND')
    expect(snapshot).toContain('SOURCE_COMPLETE')
    expect(snapshot).toContain('user · human')
    expect(snapshot).toContain('A · A · Bot')
    expect(snapshot).toContain('write · completed')
    expect(snapshot).not.toContain('PRIVATE_REASONING')
    expect(snapshot).not.toContain('/debug')
    expect(snapshot).not.toContain('Debug ·')
    expect(snapshot).not.toContain('list_coding_tools')
    const errors: string[] = []
    f.host.subscribe((event) => {
      if (event.type === 'error') errors.push(event.message)
    })
    const release = spyOn(f.pi, 'releaseSession').mockRejectedValueOnce(new Error('RELEASE_FAILED'))
    const second = await switchSettled(f, first, 'opencode')
    release.mockRestore()
    expect(errors).toContain('RELEASE_FAILED')
    expect(f.requests).toHaveLength(3)
    expect(JSON.stringify(f.store.handoff(second.id)).match(/SOURCE_COMPLETE/g)).toHaveLength(1)
    expect(f.store.continues(old.id)).toBe(true)
    expect(f.store.hasResetSince('A', old.address.id, input!.createdAt)).toBe(false)
    const resumed = await f.host.receive('A', human('resume', 'FIRST_NEW_REQUEST'))
    expect(resumed!.bindingId).toBe(second.id)
    expect(resumed!.prompt).toContain('SOURCE_COMPLETE')
    expect(resumed!.prompt).toContain('UNREAD_BACKGROUND')
    expect(f.store.contextFiles(resumed!.id)).toHaveLength(1)
    await until(() => f.store.outputs().some((item) => item.inputId === resumed!.id && item.relayed))
    const next = await f.host.receive('A', human('later', 'SECOND_NEW_REQUEST'))
    expect(next!.prompt).not.toContain('SOURCE_COMPLETE')
    expect(await Bun.file(join(f.workspace, 'completed.txt')).text()).toBe('EXISTING_WORK')
    expect(
      f.requests.slice(3).every((request) => !JSON.stringify(request.messages).includes('PRIVATE_REASONING'))
    ).toBe(true)
  } finally {
    await f.close()
  }
}, 30_000)

test('handoff refuses in-flight work and mutations, and failed target preparation keeps the source usable', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await handoffFixture(async () => {
    await gate
    return 'DONE'
  })
  try {
    const binding = await f.host.createConversation('A', human('address', '').address)
    const mutation = f.host.beginSessionMutation(binding.id)
    await expect(f.host.switchBackend(binding.id, 'pi', 'ineffa-test/echo')).rejects.toMatchObject({
      code: 'session_busy',
    })
    mutation()
    mutation()
    const ensure = f.pi.ensure.bind(f.pi)
    f.pi.ensure = async () => {
      throw new Error('PREPARATION_FAILED')
    }
    await expect(f.host.switchBackend(binding.id, 'pi', 'ineffa-test/echo')).rejects.toThrow('PREPARATION_FAILED')
    expect(f.store.binding(binding.id).archivedAt).toBeNull()
    expect(f.store.successor(binding.id)).toBeUndefined()
    expect(f.store.bindings()).toHaveLength(1)
    f.pi.ensure = ensure
    await f.host.receive('A', human('running', 'Work'))
    await until(() => f.requests.length)
    await expect(f.host.switchBackend(binding.id, 'pi', 'ineffa-test/echo')).rejects.toMatchObject({
      code: 'session_busy',
    })
    expect(f.store.binding(binding.id).archivedAt).toBeNull()
  } finally {
    release()
    await f.close()
  }
}, 30_000)

test('handoff rejects restrictive permissions and unresolved delivery without archiving', async () => {
  const f = await handoffFixture(() => 'DONE')
  try {
    const binding = await f.host.createConversation('A', human('address', '').address)
    await f.engine.native.permission.rules({
      sessionID: binding.sessionId,
      permissions: [{ action: 'shell', resource: '*', effect: 'deny' }],
    })
    await expect(f.host.switchBackend(binding.id, 'pi', 'ineffa-test/echo')).rejects.toMatchObject({
      code: 'handoff_permissions',
    })
    await f.engine.native.permission.rules({ sessionID: binding.sessionId, permissions: [] })
    const output = f.store.prepareOutput(binding.id, 'uncertain', null, 'Uncertain message')
    f.store.outputState(output.id, 'unknown')
    await expect(f.host.switchBackend(binding.id, 'pi', 'ineffa-test/echo')).rejects.toMatchObject({
      code: 'handoff_pending_delivery',
    })
    expect(f.store.binding(binding.id).archivedAt).toBeNull()
  } finally {
    await f.close()
  }
}, 30_000)

test('handoff claim survives restart and duplicate admission; cancelled sole claim can be reused', async () => {
  const root = resolve(process.env.INEFFA_TEST_DIR ?? 'test-results/runtime')
  await mkdir(root, { recursive: true })
  const path = join(await mkdtemp(join(root, 'handoff-store-')), 'state.sqlite')
  let store = new Store(path)
  const before = store.ensure('A', human('x', '').address, 'build', '.', 'opencode')
  const id = crypto.randomUUID()
  const after = store.commitHandoff(
    before.id,
    { ...before, id, sessionId: `ses_${id.replaceAll('-', '')}`, backend: 'pi' },
    {
      entries: [{ id: 'history', role: 'assistant', author: 'A', text: 'PAST_WORK', createdAt: 1 }],
      truncated: false,
    }
  )
  const input: Inbound = {
    id: 'first',
    bindingId: after.id,
    message: human('first', 'New'),
    prompt: 'New',
    rootId: 'first',
    state: 'pending',
    createdAt: 2,
    error: null,
  }
  const saved = store.admit(input)
  expect(saved.item.prompt).toContain('PAST_WORK')
  store.close()
  store = new Store(path)
  try {
    expect(store.admit(input).fresh).toBe(false)
    expect(store.inbound(input.id)?.prompt).toBe(saved.item.prompt)
    store.inboundState(input.id, 'cancelled')
    expect(store.admit({ ...input, id: 'second' }).item.prompt).toContain('PAST_WORK')
    expect(store.admit({ ...input, id: 'third' }).item.prompt).not.toContain('PAST_WORK')
    store.remove(before.id)
    expect(store.binding(after.id).predecessorId).toBeUndefined()
  } finally {
    store.close()
  }
})

test('handoff bounds serialized historical data and keeps the most recent records', () => {
  const result = boundHandoff(
    Array.from({ length: 500 }, (_, index) => ({
      id: String(index),
      role: 'user' as const,
      author: 'a'.repeat(1000),
      text: `${index}:` + '\n'.repeat(10000),
      createdAt: index,
    }))
  )
  expect(JSON.stringify(result.entries).length).toBeLessThanOrEqual(24_000)
  expect(result.entries.length).toBeLessThanOrEqual(64)
  expect(result.entries.at(-1)?.id).toBe('499')
  expect(result.truncated).toBe(true)
})

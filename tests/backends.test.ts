import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { type Engine, type EngineSession, IneffaError, Store, modelReference } from 'ineffa'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TestAdapter, fixture, human } from './fixture'

import type { Delivery } from '../packages/ineffa/src/delivery'
import { Presentation } from '../packages/ineffa/src/presentation'

/** A separate runtime makes routing errors observable without another model request. */
function alternateEngine() {
  const sessions = new Map<string, EngineSession>()
  const submitted: string[] = []
  const removed: string[] = []
  const engine: Engine = {
    backend: 'pi',
    capabilities: { permissions: false, agents: false, compact: false, steer: false },
    debug: { enabled: () => false, usage() {}, clear() {}, finish() {}, report: () => '' },
    async configureFileTool() {},
    async configureAccountPrompts() {},
    async ready() {},
    async ensure(binding, model) {
      if (!sessions.has(binding.sessionId)) {
        sessions.set(binding.sessionId, {
          id: binding.sessionId,
          agent: binding.agent,
          model: modelReference(model),
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        })
      }
      return this.getSession(binding.sessionId)
    },
    async getSession(id) {
      const session = sessions.get(id)
      if (!session) throw new Error(`Unknown alternate session ${id}`)
      return session
    },
    async switchModel(id, model) {
      const session = await this.getSession(id)
      session.model = model
    },
    async renameSession() {},
    async removeSession(id) {
      if (!sessions.has(id)) throw new IneffaError('session_not_found', 'Missing session', 404)
      removed.push(id)
      sessions.delete(id)
    },
    async exportSession() {},
    async compactSession() {},
    async active() {
      return {}
    },
    async submit(binding, input) {
      submitted.push(`${binding.sessionId}:${input.id}`)
    },
    async *log(_binding, signal) {
      if (!signal.aborted)
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
    async *events(signal) {
      if (!signal.aborted)
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
    async message() {
      throw new Error('No messages')
    },
    async messages() {
      return { data: [], cursor: {} }
    },
    async inputForAssistant() {
      return undefined
    },
    async pending() {
      return []
    },
    async cancelPending() {},
    async steerPending() {},
    async stop() {},
    async listForms() {
      return []
    },
    async getFormState() {
      return undefined
    },
    async replyForm() {},
    async cancelForm() {},
    async close() {},
  }
  return { engine, sessions, submitted, removed }
}

test('existing sessions stay on their backend; /new adopts the account default without copying a foreign model', async () => {
  const alternate = alternateEngine()
  const f = await fixture(() => 'OK', {}, 0, false, false, [alternate.engine])
  try {
    const adapter = new TestAdapter('A', f.workspace)
    adapter.model = 'ineffa-test/echo'
    await f.host.addAdapter(adapter)
    const address = human('address', '').address
    const original = await f.host.createConversation('A', address)
    expect(original.backend).toBe('opencode')

    adapter.backend = 'pi'
    adapter.model = 'other-provider/other-model'
    await f.host.syncAccountModel('A')
    expect(f.store.binding(original.id).backend).toBe('opencode')
    expect((await f.engine.getSession(original.sessionId)).model?.id).toBe('echo')
    expect(alternate.sessions.size).toBe(0)

    const input = await f.host.receive('A', human('switch', '/new'))
    const next = f.store.binding(input!.bindingId)
    expect(next.backend).toBe('pi')
    expect(f.store.binding(original.id).archivedAt).not.toBeNull()
    expect((await alternate.engine.getSession(next.sessionId)).model?.id).toBe('other-model')
    await f.host.receive('A', human('next', 'Continue'))
    expect(alternate.submitted).toHaveLength(1)
    expect(alternate.submitted[0]).toStartWith(`${next.sessionId}:`)
    expect(f.requests).toHaveLength(0)
    // A backend deletion can commit before the routing receipt does.
    await alternate.engine.removeSession(next.sessionId)
    await f.host.removeConversation(next.id)
    expect(alternate.removed).toEqual([next.sessionId])
    expect((await f.engine.getSession(original.sessionId)).id).toBe(original.sessionId)
  } finally {
    await f.close()
  }
}, 30_000)

test('web reset keeps the chosen backend and model; unsupported steering is rejected', async () => {
  const alternate = alternateEngine()
  const f = await fixture(() => 'OK', {}, 0, false, false, [alternate.engine])
  try {
    const adapter = new TestAdapter('A', f.workspace)
    adapter.platform = 'web'
    await f.host.addAdapter(adapter)
    const original = await f.host.createConversation('A', human('a', '').address, undefined, 'pi', 'p/m')
    const next = await f.host.reset(original.id)
    expect(next.backend).toBe('pi')
    expect((await alternate.engine.getSession(next.sessionId)).model).toEqual({ providerID: 'p', id: 'm' })
    await expect(f.host.receive('A', { ...human('steer', 'change'), mode: 'steer' })).rejects.toThrow('排队发送')
    expect(alternate.submitted).toHaveLength(0)
  } finally {
    await f.close()
  }
}, 30_000)

test('legacy delivery databases assign OpenCode without changing native session IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ineffa-backend-'))
  const path = join(directory, 'delivery.sqlite')
  const before = new Store(path)
  const original = before.ensure('a', human('a', '').address, 'build', directory)
  before.close()
  const legacy = new Database(path)
  legacy.exec(`
    DROP INDEX handoff_successor;
    DROP TABLE handoffs;
    ALTER TABLE inbound DROP COLUMN settled;
    ALTER TABLE bindings DROP COLUMN predecessorId;
    ALTER TABLE bindings DROP COLUMN backend;
    ALTER TABLE bindings DROP COLUMN model;
    PRAGMA user_version=8;
  `)
  legacy.close()
  const after = new Store(path)
  try {
    expect(after.binding(original.id).backend).toBe('opencode')
    expect(after.binding(original.id).sessionId).toBe(original.sessionId)
    expect(after.ensure('a', original.address, 'build', directory, 'pi').backend).toBe('opencode')
    const next = after.replace({ ...after.binding(original.id), backend: 'pi', model: 'p/m' })
    expect(next.backend).toBe('pi')
    expect(next.model).toBe('p/m')
  } finally {
    after.close()
  }
})

test('live text from a new turn cannot overwrite the previous card while durable events catch up', () => {
  const store = new Store(':memory:')
  const binding = store.ensure('a', human('a', '').address, 'build', '.')
  const outputs: { source: string; text: string }[] = []
  const presentation = new Presentation({
    publish(_binding, source, _input, text) {
      outputs.push({ source, text })
    },
  } as Delivery)
  function started(id: string) {
    presentation.observe(binding, {
      type: 'session.execution.started',
      data: { sessionID: binding.sessionId },
      created: 1,
    })
    presentation.observe(binding, {
      type: 'session.step.started',
      data: { sessionID: binding.sessionId, assistantMessageID: id },
      created: 1,
    })
  }
  function delta(id: string, text: string) {
    presentation.delta(binding, {
      type: 'session.text.delta',
      data: { sessionID: binding.sessionId, assistantMessageID: id, ordinal: 0, delta: text },
      created: 1,
    })
  }
  try {
    started('first')
    delta('first', 'First reply')
    delta('second', 'Second')
    expect(outputs).toEqual([{ source: 'first', text: 'First reply' }])
    started('second')
    delta('second', ' reply')
    expect(outputs.at(-1)).toEqual({ source: 'second', text: 'Second reply' })
  } finally {
    store.close()
  }
})

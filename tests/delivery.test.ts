import { describe, expect, test } from 'bun:test'
import { type Adapter, type Inbound, Store } from 'ineffa'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { TestAdapter, human, until } from './fixture'

import { Delivery } from '../packages/ineffa/src/delivery'

function setup() {
  const store = new Store(':memory:')
  const adapter = new TestAdapter('A', process.cwd())
  const binding = store.ensure('A', human('a', '').address, 'build', process.cwd())
  let relays = 0
  const delivery = new Delivery(
    store,
    () => adapter,
    async () => {
      relays++
    },
    () => {}
  )
  return { store, adapter, binding, delivery, relays: () => relays }
}
describe('confirmed public delivery', () => {
  test('note-only changes edit the same reply and remain separate from its body', async () => {
    const f = setup()
    const adapter: Adapter = f.adapter
    const edits: { text: string; notes?: string[] }[] = []
    adapter.edit = async (id, message) => {
      edits.push(message)
      return { status: 'sent', messageId: id }
    }
    try {
      f.delivery.publish(f.binding, 'single-turn', null, 'BODY', 'reply', false, ['10 tks · grep x1'])
      await f.delivery.flush()
      const first = f.store.outputs()[0]!
      f.delivery.publish(f.binding, 'single-turn', null, 'BODY', 'reply', false, ['20 tks · grep x2'])
      await f.delivery.flush()
      expect(f.store.outputs()[0]!.revision).toBeGreaterThan(first.revision)
      f.store.saveDebugReport(f.binding.id, 'single-turn', '\n\n> Debug · 总计 5s')
      f.delivery.publish(f.binding, 'single-turn', null, 'BODY', 'reply', true, ['30 tks · grep x3'])
      await f.delivery.flush()
      expect(f.adapter.sent).toHaveLength(1)
      expect(edits.at(-1)?.notes).toEqual(['30 tks · grep x3', 'Debug · 总计 5s'])
      expect(edits.at(-1)?.text).toBe('BODY')
      expect(f.store.outputs()).toHaveLength(1)
      expect(f.store.contextQuote('RAW_CARD_WITH_NOTES', first.messageId!)).toBe('BODY')
    } finally {
      f.store.close()
    }
  })

  test('version 7 migration preserves replies and version 8 persists notes on restart', async () => {
    const root = resolve(process.env.INEFFA_TEST_DIR ?? 'test-results/runtime')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'notes-'))
    const path = join(directory, 'store.sqlite')
    let store = new Store(path)
    try {
      const binding = store.ensure('A', human('a', '').address, 'build', directory)
      const old = store.prepareOutput(binding.id, 'old', null, 'OLD_BODY')
      store.db.exec('ALTER TABLE outbound DROP COLUMN notes; PRAGMA user_version=7;')
      store.close()
      store = new Store(path)
      expect(store.output(old.id)?.text).toBe('OLD_BODY')
      const next = store.prepareOutput(binding.id, 'new', null, 'NEW_BODY', { notes: ['1 k · grep x2'] })
      store.close()
      store = new Store(path)
      expect(store.output(next.id)?.notes).toEqual(['1 k · grep x2'])
      expect(store.output(next.id)?.text).toBe('NEW_BODY')
    } finally {
      store.close()
    }
  })

  test('an old creation echo cannot confirm a newer final edit or relay its mentions', async () => {
    const f = setup()
    const adapter: Adapter = f.adapter
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let editing = false
    adapter.edit = async (id) => {
      editing = true
      await gate
      return { status: 'sent', messageId: id }
    }
    try {
      f.adapter.outcome = { status: 'unknown', error: 'lost creation receipt' }
      f.delivery.publish(f.binding, 'stream', null, '@B partial')
      await f.delivery.flush()
      const output = f.store.outputs()[0]!
      f.delivery.publish(f.binding, 'stream', null, '@B final', 'reply', true)
      await f.delivery.flush()
      expect(f.adapter.sent).toHaveLength(1)
      expect(f.relays()).toBe(0)
      f.delivery.confirm('A', output.id, 'remote')
      await until(() => editing)
      f.delivery.confirm('A', output.id, 'remote')
      expect(f.store.output(output.id)?.state).toBe('sending')
      expect(f.relays()).toBe(0)
      release()
      await f.delivery.flush()
      expect(f.relays()).toBe(1)
      expect(f.store.output(output.id)?.text).toBe('@B final')
      expect(f.adapter.sent).toHaveLength(1)
    } finally {
      release()
      await f.delivery.flush()
      f.store.close()
    }
  })
  test('a new delivery instance edits the persisted preview and never relays status messages', async () => {
    const f = setup()
    const adapter: Adapter = f.adapter
    const edits: string[] = []
    adapter.edit = async (id, message) => {
      edits.push(message.text)
      return { status: 'sent', messageId: id }
    }
    try {
      f.delivery.publish(f.binding, 'tools:turn', null, '(— tks) grep x1', 'tools')
      await f.delivery.flush()
      const restored = new Delivery(
        f.store,
        () => adapter,
        async () => {
          throw new Error('status relayed')
        },
        () => {}
      )
      restored.publish(f.binding, 'tools:turn', null, '(123 tks) grep x2', 'tools', true)
      await restored.flush()
      expect(f.adapter.sent).toHaveLength(1)
      expect(edits).toEqual(['(123 tks) grep x2'])
      expect(f.store.outputs()[0]?.relayed).toBe(true)
    } finally {
      f.store.close()
    }
  })
  test('discarding a conversation drops buffered drafts but preserves committed final replies', async () => {
    const f = setup()
    const adapter: Adapter = f.adapter
    adapter.edit = async (id) => ({ status: 'sent', messageId: id })
    try {
      f.delivery.publish(f.binding, 'draft', null, 'DRAFT')
      f.delivery.publish(f.binding, 'final', null, 'FINAL', 'reply', true)
      f.store.archive(f.binding.id)
      f.delivery.discard(f.binding)
      await f.delivery.flush()
      expect(f.adapter.sent.map((item) => item.text)).toEqual(['FINAL'])
    } finally {
      await f.delivery.flush()
      f.store.close()
    }
  })
  test('deleted conversations discard queued sends and ignore in-flight receipts', async () => {
    const f = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const sending = new Promise<void>((resolve) => {
      started = resolve
    })
    f.adapter.send = async () => {
      started()
      await gate
      return { status: 'sent', messageId: 'remote' }
    }
    try {
      const first = f.store.prepareOutput(f.binding.id, 'first', null, 'first')
      const second = f.store.prepareOutput(f.binding.id, 'second', null, 'second')
      const job = f.delivery.enqueue(first.id)
      void f.delivery.enqueue(second.id)
      await sending
      f.store.remove(f.binding.id)
      release()
      await job
      await f.delivery.flush()
      expect(f.store.outputs()).toEqual([])
      expect(f.relays()).toBe(0)
    } finally {
      release()
      await f.delivery.flush()
      f.store.close()
    }
  })
  test('a failed local relay remains visible and retries without another platform send', async () => {
    const f = setup()
    let attempts = 0
    const delivery = new Delivery(
      f.store,
      () => f.adapter,
      async () => {
        if (++attempts === 1) throw new Error('recipient unavailable')
      },
      () => {}
    )
    try {
      const out = f.store.prepareOutput(f.binding.id, 'relay', null, '@B work')
      await delivery.enqueue(out.id)
      expect(f.store.output(out.id)?.state).toBe('sent')
      expect(f.store.output(out.id)?.relayed).toBe(false)
      expect(f.store.output(out.id)?.error).toBe('recipient unavailable')
      await delivery.enqueue(out.id)
      expect(f.store.output(out.id)?.relayed).toBe(true)
      expect(f.store.output(out.id)?.error).toBeNull()
      expect(f.adapter.sent.length).toBe(1)
    } finally {
      f.store.close()
    }
  })
  test('an ambiguous transport result is not retried or relayed', async () => {
    const f = setup()
    try {
      f.adapter.outcome = { status: 'unknown', error: 'connection lost' }
      const out = f.store.prepareOutput(f.binding.id, 'msg', null, '@B work')
      await f.delivery.enqueue(out.id)
      await f.delivery.enqueue(out.id)
      expect(f.adapter.sent.length).toBe(1)
      expect(f.relays()).toBe(0)
      expect(f.store.output(out.id)?.state).toBe('unknown')
    } finally {
      f.store.close()
    }
  })
  test('gateway echo confirms an ambiguous send and relays only once', async () => {
    const f = setup()
    try {
      f.adapter.outcome = { status: 'unknown', error: 'timeout' }
      const out = f.store.prepareOutput(f.binding.id, 'msg', null, '@B work')
      await f.delivery.enqueue(out.id)
      f.delivery.confirm('wrong-account', out.id, 'remote')
      expect(f.store.output(out.id)?.state).toBe('unknown')
      f.delivery.confirm('A', out.id, 'remote')
      await f.delivery.flush()
      f.delivery.confirm('A', out.id, 'remote')
      await f.delivery.flush()
      expect(f.relays()).toBe(1)
      expect(f.adapter.sent.length).toBe(1)
      expect(f.store.output(out.id)?.state).toBe('sent')
    } finally {
      f.store.close()
    }
  })
  test('durable root budget and stable identifiers stop mention loops', () => {
    const f = setup()
    try {
      function make(id: string): Inbound {
        return {
          id,
          bindingId: f.binding.id,
          message: { ...human(id, 'reply'), author: { id: 'B', name: 'B', bot: true } },
          prompt: 'reply',
          rootId: 'root',
          state: 'pending',
          error: null,
          createdAt: Date.now(),
        }
      }
      expect(f.store.admit(make('one'), 2).fresh).toBe(true)
      expect(f.store.admit(make('one'), 2).fresh).toBe(false)
      f.store.admit(make('two'), 2)
      expect(() => f.store.admit(make('three'), 2)).toThrow('自动唤醒上限')
      f.store.archive(f.binding.id)
      const next = f.store.ensure('A', f.binding.address, 'build', process.cwd())
      expect(next.sessionId).not.toBe(f.binding.sessionId)
      expect(f.store.hasResetSince('A', f.binding.address.id, f.binding.createdAt)).toBe(true)
      expect(f.store.binding(f.binding.id).archivedAt).not.toBeNull()
    } finally {
      f.store.close()
    }
  })
})

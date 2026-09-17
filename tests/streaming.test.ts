import { expect, test } from 'bun:test'
import type { OutgoingMessage, SendResult } from 'ineffa'

import { TestAdapter, fixture, human, modelAccount, until } from './fixture'

import { formatOutputTokens } from '../packages/ineffa/src/presentation'

test.each([
  [undefined, '— tks'],
  [0, '0 tks'],
  [999, '999 tks'],
  [1_000, '1 k'],
  [1_223, '1.223 k'],
  [999_999, '999.999 k'],
  [1_000_000, '1 Mtks'],
  [1_223_456, '1.223 Mtks'],
] as const)('formats %s output tks as %s', (count, expected) => {
  expect(formatOutputTokens(count)).toBe(expected)
})

class StreamingAdapter extends TestAdapter {
  writes: { message: OutgoingMessage; at: number; edit: boolean }[] = []

  override async send(message: OutgoingMessage): Promise<SendResult> {
    this.writes.push({ message: { ...message }, at: Date.now(), edit: false })
    return super.send(message)
  }

  async edit(messageId: string, message: OutgoingMessage): Promise<SendResult> {
    expect(messageId).toBe(`remote-${message.id}`)
    this.writes.push({ message: { ...message }, at: Date.now(), edit: true })
    const index = this.sent.findIndex((item) => item.id === message.id)
    expect(index).toBeGreaterThanOrEqual(0)
    this.sent[index] = { ...message }
    return { status: 'sent', messageId }
  }
}

test.each(['/new', '/abort'])(
  '%s stops a streaming thought and finishes its status',
  async (command) => {
    const f = await fixture(() => ({
      stream: Array.from({ length: 12 }, () => ({ thinking: 'PRIVATE_REASONING', delay: 100 })),
      usage: { output: 40, reasoning: 40 },
    }))
    try {
      const a = new StreamingAdapter('A', f.workspace)
      await f.host.addAdapter(a)
      await f.host.receive('A', human('start', 'think'))
      await until(() => a.sent.some((item) => item.kind === 'reply' && item.partial))
      const previous = f.store.current('A', 'channel:guild:1')!
      await f.host.receive('A', human('reset', command))
      await until(() => a.sent.some((item) => item.kind === 'reply' && !item.partial))
      expect(a.sent.find((item) => item.kind === 'reply')?.notes?.join('\n')).toContain('Think interrupted')
      expect(a.sent.filter((item) => item.kind === 'reply')).toHaveLength(1)
      const current = f.store.current('A', previous.address.id)!
      if (command === '/new') expect(current.id).not.toBe(previous.id)
      else expect(current.id).toBe(previous.id)
      expect(f.requests).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  30_000
)

test('streaming edits one response with notes, counts output plus reasoning, and relays only final body', async () => {
  let calls = 0
  const f = await fixture((request) => {
    if (modelAccount(request)?.platformId === 'B') return 'B_DONE'
    if (++calls === 1) return { stream: [], tool: 'list_coding_tools', input: {}, usage: { output: 0, reasoning: 0 } }
    if (calls === 2)
      return {
        stream: [
          ...Array.from({ length: 6 }, () => ({ thinking: 'PRIVATE_REASONING', delay: 150 })),
          { text: '先检查文件。' },
        ],
        tool: 'write',
        input: { path: 'stream.txt', content: 'DONE' },
        usage: { output: 100, reasoning: 40 },
      }
    return {
      stream: [
        { text: '@B ' },
        ...Array.from({ length: 12 }, () => ({ text: 'word ', delay: 120 })),
        { text: 'FINAL' },
      ],
      usage: { output: 1123, reasoning: 0 },
    }
  })
  try {
    const a = new StreamingAdapter('A', f.workspace)
    const b = new TestAdapter('B', f.workspace)
    await f.host.addAdapter(a)
    await f.host.addAdapter(b)
    await f.host.receive('A', human('on', '/debug on'))
    await f.host.receive('A', human('stream', 'do the work'))
    await until(() => a.writes.some((item) => item.message.kind === 'reply' && item.message.partial))
    expect(b.sent).toHaveLength(0)
    await until(() => b.sent.some((item) => item.text === 'B_DONE'))
    await until(() => a.sent.some((item) => item.kind === 'reply' && !item.partial))
    expect(a.sent.filter((item) => item.kind === 'tools' || item.kind === 'thinking')).toHaveLength(0)
    const reply = a.sent.find((item) => item.kind === 'reply')!
    expect(reply.notes?.[0]).toBe('1.223 k · write x1 · Think complete')
    // The directory step already reported zero tokens before reasoning starts.
    expect(a.writes.some((item) => item.message.notes?.[0] === '0 tks · Think in progress')).toBe(true)
    expect(a.writes.some((item) => item.message.kind === 'reply' && item.edit)).toBe(true)
    expect(a.writes.filter((item) => item.message.kind === 'reply' && !item.edit)).toHaveLength(1)
    expect(a.sent.filter((item) => item.kind === 'reply')).toHaveLength(1)
    expect(reply.text).toContain('FINAL')
    expect(reply.text).toStartWith('先检查文件。\n\n')
    expect(reply.text).not.toContain('Debug')
    expect(reply.notes?.at(-1)).toContain('Debug ·')
    for (const id of new Set(a.writes.map((item) => item.message.id))) {
      const writes = a.writes.filter((item) => item.message.id === id)
      for (let index = 1; index < writes.length; index++)
        expect(writes[index]!.at - writes[index - 1]!.at).toBeGreaterThanOrEqual(480)
    }
    const forwarded = JSON.stringify(f.requests.filter((request) => modelAccount(request)?.platformId === 'B'))
    expect(forwarded).toContain('FINAL')
    expect(forwarded).not.toContain('1.223 k')
    expect(forwarded).not.toContain('Think complete')
    expect(forwarded).not.toContain('Debug ·')
    expect(forwarded).not.toContain('/debug')
    expect(a.writes.some((item) => item.message.text.includes('PRIVATE_REASONING'))).toBe(false)
    const final = a.sent.find((item) => item.kind === 'reply')!
    await f.host.receive('A', {
      ...human('quote', 'continue'),
      quote: JSON.stringify([{ type: 'card', modules: [{ type: 'context', elements: final.notes }] }]),
      quoteId: `remote-${final.id}`,
    })
    await until(() => calls === 4)
    expect(JSON.stringify(f.requests.at(-1))).not.toContain('Debug ·')
    expect(JSON.stringify(f.requests.at(-1))).not.toContain('(1.223 k)')
  } finally {
    await f.close()
  }
}, 30_000)

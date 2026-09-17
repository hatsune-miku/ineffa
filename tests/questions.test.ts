import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store } from 'ineffa'
import { join } from 'node:path'

import { TestAdapter, fixture, human, until } from './fixture'

const prompts = [
  {
    header: '颜色',
    question: '选择颜色',
    options: [
      { label: '蓝', description: '蓝色' },
      { label: '粉', description: '粉色' },
    ],
  },
  {
    header: '格式',
    question: '选择格式',
    options: [
      { label: 'PNG', description: '图片' },
      { label: 'TXT', description: '文本' },
    ],
    multiple: true,
  },
]

test('question targets the initiating human, accepts unmentioned answers, and deduplicates between fields', async () => {
  const f = await fixture((request) => {
    const result = request.messages.filter((message) => message.role === 'tool').at(-1)
    if (!result) return { tool: 'list_tools', input: {} }
    if (String(result.content).includes('"name":"question"')) {
      return { tool: 'question', input: { questions: prompts } }
    }
    return 'DONE'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    const oldMessage = human('before-question', '之前说的话', [])
    await f.host.receive('A', oldMessage)
    await f.host.receive('A', human('ask', '请问我两个问题'))
    await until(() => a.sent.some((message) => message.text.includes('选择颜色')))
    const first = a.sent.find((message) => message.text.includes('选择颜色'))!
    expect(first.kind).toBe('notice')
    expect(first.text).toContain('@human')
    const binding = f.store.current('A', 'channel:guild:1')!
    const form = (await f.engine.native.form.list({ sessionID: binding.sessionId }))[0]!
    expect(form).toBeDefined()
    await f.host.receive('A', oldMessage)
    expect(a.sent.some((message) => message.text.includes('选择格式'))).toBe(false)
    await f.host.receive('A', { ...human('other', '2', []), author: { id: 'other', name: 'Other', bot: false } })
    expect((await f.engine.native.form.state({ sessionID: binding.sessionId, formID: form.id })).status).toBe('pending')
    const answer = human('answer-one', '2', [])
    await Promise.all([f.host.receive('A', answer), f.host.receive('A', answer)])
    await until(() => a.sent.some((message) => message.text.includes('选择格式')))
    await f.host.receive('A', answer)
    expect((await f.engine.native.form.state({ sessionID: binding.sessionId, formID: form.id })).status).toBe('pending')
    await f.host.receive('A', human('answer-two', '1, 2', []))
    await until(() => a.sent.some((message) => message.text === 'DONE'))
    expect(await f.engine.native.form.state({ sessionID: binding.sessionId, formID: form.id })).toEqual({
      status: 'answered',
      answer: { q0: '粉', q1: ['PNG', 'TXT'] },
    })
    const users = (await f.engine.messages(binding.sessionId)).data.filter((message) => message.type === 'user')
    expect(users).toHaveLength(1)
    const transcript = JSON.stringify(f.requests.at(-1)!.messages)
    expect(transcript).toContain('粉')
    expect(transcript).not.toContain('无需 @')
    await f.host.receive('A', human('answer-two', '1, 2', []))
    expect(f.store.observed(binding.id).map((input) => input.message.id)).toEqual(['other'])
  } finally {
    await f.close()
  }
}, 30_000)

test('restart expires upstream memory-only forms and retains answer receipts without reasking', async () => {
  const f = await fixture(() => 'READY')
  let restored: Host | undefined
  let closed = false
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    const input = await f.host.receive('A', human('begin', 'begin'))
    await until(() => a.sent.some((message) => message.text === 'READY'))
    const binding = f.store.binding(input!.bindingId)
    const form = await f.engine.native.form.create({
      sessionID: binding.sessionId,
      title: 'Questions',
      metadata: { kind: 'question' },
      fields: [
        { key: 'q0', type: 'string', description: 'FIRST', custom: true },
        { key: 'q1', type: 'string', description: 'SECOND', custom: true },
      ],
    })
    await until(() => a.sent.some((message) => message.text.includes('FIRST')))
    const reply = human('first-answer', 'one', [])
    await f.host.receive('A', reply)
    await until(() => a.sent.some((message) => message.text.includes('SECOND')))
    await f.host.delivery.flush()
    await f.host.close()
    closed = true
    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    restored = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    const b = new TestAdapter('A', f.workspace)
    await restored.addAdapter(b)
    await restored.start()
    await restored.receive('A', reply)
    expect(await engine.native.form.list({ sessionID: binding.sessionId })).toEqual([])
    await restored.receive('A', human('second-answer', 'two', []))
    expect(restored.store.observed(binding.id).map((input) => input.message.id)).toEqual(['second-answer'])
    await until(() => b.sent.some((message) => message.text.includes('失效')))
    expect(b.sent.filter((message) => /FIRST|SECOND/.test(message.text))).toEqual([])
  } finally {
    if (restored) await restored.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

test('a web answer closes platform capture and an unrelated channel cannot answer', async () => {
  const f = await fixture((request) => {
    const result = request.messages.filter((message) => message.role === 'tool').at(-1)
    if (!result) return { tool: 'list_tools', input: {} }
    if (String(result.content).includes('"name":"question"')) {
      return { tool: 'question', input: { questions: [prompts[0]] } }
    }
    return 'DONE'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('ask', 'ASK'))
    await until(() => a.sent.some((message) => message.text.includes('选择颜色')))
    const binding = f.store.current('A', 'channel:guild:1')!
    const form = (await f.engine.native.form.list({ sessionID: binding.sessionId }))[0]!
    const unrelated = {
      ...human('elsewhere', '1', []),
      address: { id: 'channel:guild:2', title: 'other', kind: 'channel' as const },
    }
    await f.host.receive('A', unrelated)
    expect((await f.engine.native.form.state({ sessionID: binding.sessionId, formID: form.id })).status).toBe('pending')
    await f.engine.native.form.reply({ sessionID: binding.sessionId, formID: form.id, answer: { q0: 'Web' } })
    await until(() => a.sent.some((message) => message.text === 'DONE'))
    await f.host.receive('A', human('ordinary', '普通消息', []))
    expect(f.store.observed(binding.id).at(-1)?.message.text).toBe('普通消息')
  } finally {
    await f.close()
  }
}, 30_000)

test('two bots asking the same human require a quote or a specific bot mention', async () => {
  const f = await fixture(() => 'READY')
  try {
    const adapters = [new TestAdapter('A', f.workspace), new TestAdapter('B', f.workspace)]
    for (const adapter of adapters) {
      await f.host.addAdapter(adapter)
      await f.host.receive(adapter.id, human(`start-${adapter.id}`, 'begin', [adapter.id]))
    }
    await until(() => adapters.every((adapter) => adapter.sent.some((message) => message.text === 'READY')))
    const forms = []
    for (const adapter of adapters) {
      const binding = f.store.current(adapter.id, 'channel:guild:1')!
      forms.push(
        await f.engine.native.form.create({
          sessionID: binding.sessionId,
          title: 'Question',
          metadata: { kind: 'question' },
          fields: [{ key: 'q0', type: 'string', description: 'Choose', custom: true }],
        })
      )
    }
    await until(() => adapters.every((adapter) => adapter.sent.some((message) => message.text.includes('Choose'))))
    const ambiguous = human('ambiguous', 'yes', [])
    for (const adapter of adapters) await f.host.receive(adapter.id, ambiguous)
    for (const form of forms)
      expect((await f.engine.native.form.state({ sessionID: form.sessionID, formID: form.id })).status).toBe('pending')
    const notice = adapters[0]!.sent.find((message) => message.text.includes('Choose'))!
    const reply = { ...human('quote-answer', 'first', []), quoteId: `remote-${notice.id}` }
    for (const adapter of adapters) await f.host.receive(adapter.id, reply)
    expect((await f.engine.native.form.state({ sessionID: forms[0]!.sessionID, formID: forms[0]!.id })).status).toBe(
      'answered'
    )
    expect((await f.engine.native.form.state({ sessionID: forms[1]!.sessionID, formID: forms[1]!.id })).status).toBe(
      'pending'
    )
  } finally {
    await f.close()
  }
}, 30_000)

test('pending question supports an allowed DM answer and /abort without a mention cancels the wait', async () => {
  const f = await fixture((request) => {
    const result = request.messages.filter((message) => message.role === 'tool').at(-1)
    if (!result) return { tool: 'list_tools', input: {} }
    if (String(result.content).includes('"name":"question"')) {
      return { tool: 'question', input: { questions: [prompts[0]] } }
    }
    return 'DONE'
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', human('ask', 'ASK'))
    await until(() => a.sent.some((message) => message.text.includes('选择颜色')))
    await f.host.receive('A', {
      ...human('dm-answer', '自定义', []),
      address: { id: 'dm:human', title: 'DM', kind: 'direct' },
    })
    await until(() => a.sent.some((message) => message.text === 'DONE'))
    expect(f.store.current('A', 'dm:human')).toBeUndefined()
    const binding = f.store.current('A', 'channel:guild:1')!
    await f.host.reset(binding.id)
    await f.host.receive('A', human('ask-again', 'ASK'))
    await until(() => a.sent.filter((message) => message.text.includes('选择颜色')).length === 2)
    const current = f.store.current('A', 'channel:guild:1')!
    await f.host.receive('A', human('abort', '/abort', []))
    await until(() => a.sent.some((message) => message.text === '已停止。'))
    await until(async () => (await f.engine.native.form.list({ sessionID: current.sessionId })).length === 0)
    expect(await f.engine.native.form.list({ sessionID: current.sessionId })).toEqual([])
    await f.host.receive('A', human('after', '普通发言', []))
    expect(f.store.observed(current.id).at(-1)?.message.text).toBe('普通发言')
  } finally {
    await f.close()
  }
}, 30_000)

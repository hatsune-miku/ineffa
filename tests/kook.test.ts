import { expect, test } from 'bun:test'
import type { IncomingMessage } from 'ineffa'
import { kook, kookMentions } from 'ineffa-kook'

test('KOOK preserves guild nicknames, sender IDs and quoted authors without requiring a mention', async () => {
  const adapter = kook({ id: 'kook-context', token: 'local-test-token', directory: '.', guilds: ['987'] })
  const received: IncomingMessage[] = []
  let receive!: (event: never) => void
  adapter.native.on = (event, listener) => {
    if (event === 'textChannelEvent') receive = listener as unknown as typeof receive
    return adapter.native
  }
  adapter.native.connect = async () => {}
  await adapter.start({
    receive: async (message) => {
      received.push(message)
    },
    status: () => {},
    echo: () => {},
  })
  receive({
    channel_type: 'GROUP',
    type: 9,
    target_id: '123',
    author_id: '101',
    content: 'answer',
    msg_id: 'message-1',
    msg_timestamp: 1234,
    extra: {
      guild_id: '987',
      channel_name: 'discussion',
      mention: [],
      author: { id: '101', username: 'username', nickname: '群内昵称', bot: false },
      quote: {
        id: 'message-0',
        content: 'question',
        author: { id: '202', username: 'other', nickname: '另一个人', bot: true },
      },
    },
  } as never)
  expect(received).toHaveLength(1)
  expect(received[0]?.author).toEqual({ id: '101', name: '群内昵称', bot: false })
  expect(received[0]?.quoteAuthor).toEqual({ id: '202', name: '另一个人', bot: true })
  expect(received[0]?.quoteId).toBe('message-0')
  expect(received[0]?.quote).toBe('question')
  expect(received[0]?.mentions).toEqual([])
  await adapter.stop()
})

test('KOOK guild trust allows its channels, unions explicit channels, and keeps private and other guilds isolated', async () => {
  const options = { id: 'guild-trust', token: 'local-test-token', directory: '.' }
  expect(() => kook({ ...options, guilds: ['not-an-id'] })).toThrow('数字 ID')
  const adapter = kook({ ...options, guilds: ['987'], channels: ['456'], users: ['321'] })
  const address = { id: 'channel:987:123', guildId: '987', title: 'Guild channel', kind: 'channel' as const }
  const other = { ...address, id: 'channel:654:123', guildId: '654' }
  expect(adapter.canAccess(address)).toBe(true)
  expect(adapter.canAccess({ ...address, id: 'channel:987:999' })).toBe(true)
  expect(adapter.canAccess({ ...address, guildId: undefined })).toBe(true)
  expect(adapter.canAccess(other)).toBe(false)
  expect(adapter.canAccess({ ...other, id: 'channel:654:456' })).toBe(true)
  expect(adapter.canAccess({ id: 'channel:987', title: 'Missing guild', kind: 'channel' })).toBe(false)
  expect(adapter.canAccess({ id: 'dm:987', guildId: '987', title: 'Private', kind: 'direct' })).toBe(false)
  expect(adapter.canAccess({ id: 'dm:321', title: 'Private', kind: 'direct' })).toBe(true)
  expect(adapter.conversationKey?.(address)).toBe('channel:123')
  expect(adapter.conversationKey?.({ ...address, id: 'channel:987:999' })).toBe('channel:999')
  expect(adapter.conversationKey?.(other)).toBeUndefined()
  expect(kook(options).canAccess(address)).toBe(false)
  let calls = 0
  adapter.native.api.createMessage = async () => {
    calls++
    return { success: true, data: { msg_id: 'sent' } } as never
  }
  adapter.native.api.updateMessage = async () => {
    calls++
    return { success: true } as never
  }
  adapter.native.api.listMessages = async () => {
    calls++
    return { success: true, data: { items: [] } } as never
  }
  expect((await adapter.send({ id: 'send', address, text: 'hello' })).status).toBe('sent')
  expect((await adapter.edit!('sent', { id: 'edit', address, text: 'updated' })).status).toBe('sent')
  expect(await adapter.readHistory!(address)).toEqual([])
  expect((await adapter.send({ id: 'denied', address: other, text: 'hello' })).status).toBe('failed')
  expect((await adapter.edit!('sent', { id: 'denied-edit', address: other, text: 'updated' })).status).toBe('failed')
  await expect(adapter.readHistory!(other)).rejects.toThrow('不允许')
  expect(calls).toBe(3)
})

test('KOOK mentions require native syntax and exclude code, quotes, and escapes', () => {
  expect(
    kookMentions(
      '(met)100(met) @name `(met)200(met)`\n> (met)300(met)\n```md\n(met)400(met)\n```\n\\(met)500(met)\n(met)100(met) (met)600(met)'
    )
  ).toEqual(['100', '600'])
})
test('KOOK preserves per-account access and distinguishes rejection from uncertain delivery', async () => {
  const adapter = kook({
    id: 'kook-test',
    token: 'local-test-token',
    directory: '.',
    channels: ['123'],
    users: ['456'],
  })
  const address = { id: 'channel:guild:123', title: 'test', kind: 'channel' as const }
  const message = { id: 'nonce', address, text: 'hello' }
  function response(code: number, data = {}) {
    return { success: code === 0, code, data, message: 'test', rateLimit: undefined }
  }
  expect(adapter.canAccess(address)).toBe(true)
  expect(adapter.canAccess({ ...address, id: 'channel:guild:999' })).toBe(false)
  expect(adapter.canAccess({ id: 'dm:456', title: 'DM', kind: 'direct' })).toBe(true)
  expect(adapter.conversationKey?.(address)).toBe('channel:123')
  expect(adapter.conversationKey?.({ ...address, id: 'channel:other-format:123' })).toBe('channel:123')
  expect(adapter.conversationKey?.({ ...address, id: 'channel:guild:999' })).toBeUndefined()
  expect(adapter.conversationKey?.({ id: 'dm:456', title: 'DM', kind: 'direct' })).toBeUndefined()
  for (const code of [408, 499, 500, 1145]) {
    adapter.native.api.createMessage = async () => response(code) as never
    expect((await adapter.send(message)).status).toBe('unknown')
  }
  adapter.native.api.createMessage = async () => response(403) as never
  expect((await adapter.send(message)).status).toBe('failed')
  adapter.native.api.createMessage = async () => response(0) as never
  expect((await adapter.send(message)).status).toBe('unknown')
  adapter.native.api.createMessage = async (props) => {
    expect(props.nonce).toBe('nonce')
    return response(0, { msg_id: 'confirmed' }) as never
  }
  expect(await adapter.send(message)).toEqual({ status: 'sent', messageId: 'confirmed' })
})
test('long KOOK replies use a full markdown attachment and preserve native mentions', async () => {
  const adapter = kook({ id: 'kook-long', token: 'local-test-token', directory: '.', channels: ['123'] })
  const content = 'long reply '.repeat(1000) + '(met)456(met)'
  let uploaded = '',
    posted = ''
  adapter.native.api.uploadAsset = async (data) => {
    uploaded = await (data.get('file') as File).text()
    return { success: true, code: 0, message: '', data: { url: 'https://test.kook.example/reply.md' } } as never
  }
  adapter.native.api.createMessage = async (data) => {
    posted = data.content
    return { success: true, code: 0, message: '', data: { msg_id: 'long-message' } } as never
  }
  expect(
    (
      await adapter.send({
        id: 'long',
        address: { id: 'channel:g:123', title: 'test', kind: 'channel' },
        text: content,
      })
    ).status
  ).toBe('sent')
  expect(uploaded).toBe(content)
  expect(posted.length).toBeLessThan(7500)
  expect(kookMentions(posted)).toEqual(['456'])
  uploaded = ''
  adapter.native.api.updateMessage = async (data) => {
    expect(data.msg_id).toBe('long-message')
    posted = data.content!
    return { success: true, code: 0, message: '' } as never
  }
  const message = {
    id: 'long',
    address: { id: 'channel:g:123', title: 'test', kind: 'channel' as const },
    text: content,
  }
  expect((await adapter.edit!('long-message', { ...message, partial: true })).status).toBe('sent')
  expect(uploaded).toBe('')
  expect(posted.length).toBe(7500)
  expect((await adapter.edit!('long-message', { ...message, partial: false })).status).toBe('sent')
  expect(uploaded).toBe(content)
  expect(kookMentions(posted)).toEqual(['456'])
})

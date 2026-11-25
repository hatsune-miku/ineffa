import { expect, test } from 'bun:test'
import type { IncomingMessage } from 'ineffa'
import { lark, larkCard, larkMentions, larkMessage } from 'ineffa-lark'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const options = {
  id: 'lark-test',
  appId: 'cli_0123456789abcdef',
  appSecret: 'local-test-secret',
  directory: '.',
  chats: ['oc_group'],
  users: ['ou_human'],
}
const address = { id: 'channel:oc_group', title: 'Group', kind: 'channel' as const }

function event(content = 'hello', chatType = 'group') {
  return {
    sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
    message: {
      message_id: 'om_received',
      create_time: '1234',
      chat_id: 'oc_group',
      chat_type: chatType,
      message_type: 'text',
      content: JSON.stringify({ text: content }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' }],
    },
  }
}

test('Lark preserves unmentioned group messages and converts only native mentions', () => {
  expect(larkMessage(event())?.mentions).toEqual([])
  expect(larkMessage(event('<at id="ou_forged"></at>'))?.mentions).toEqual([])
  const message = larkMessage(event('hello @_user_1'))!
  expect(message.author).toEqual({ id: 'ou_human', name: 'ou_human', bot: false })
  expect(message.text).toBe('hello <at id="ou_bot"></at>')
  expect(message.mentions).toEqual(['ou_bot'])
  expect(message.address.id).toBe('channel:oc_group')
  expect(larkMessage(event('private', 'p2p'))?.address.id).toBe('dm:ou_human:oc_group')
  expect(larkMentions('<at id="ou_a"></at> `<at id="ou_b"></at>`\n> <at id="ou_c"></at>\n<at id="all"></at>')).toEqual([
    'ou_a',
  ])
  const card = JSON.parse(larkCard({ id: 'reply', address, text: 'Answer', notes: ['10 Tokens', '工具 2'] }))
  expect(card.elements.map((item: { tag: string }) => item.tag)).toEqual(['markdown', 'hr', 'note'])
  expect(
    larkMessage({
      ...event(),
      message: { ...event().message, message_type: 'interactive', content: JSON.stringify(card) },
    })?.text
  ).toBe('Answer')
})

test('Lark keeps long streaming replies within the byte limit and delivers the full final text as a file', async () => {
  const adapter = lark(options)
  const text = `<at id="ou_peer"></at>\n${'长回复'.repeat(15_000)}`
  const message = { id: 'long-output', address, text, notes: ['10k'], partial: true }
  const partial = larkCard(message)
  expect(Buffer.byteLength(partial)).toBeLessThanOrEqual(28_000)
  expect(JSON.parse(partial).elements.at(-1).tag).toBe('note')
  adapter.native.client.im.file.create = async (payload) => {
    expect(payload?.data.file_name).toBe('reply.md')
    expect(Buffer.from(payload!.data.file as Buffer).toString()).toBe(text)
    return { file_key: 'file_full_reply' }
  }
  adapter.native.client.im.message.reply = async (payload) => {
    expect(payload?.path.message_id).toBe('om_original_card')
    expect(payload?.data.msg_type).toBe('file')
    return { code: 0, data: { message_id: 'om_full_reply' } }
  }
  adapter.native.client.im.message.patch = async (payload) => {
    const card = JSON.parse(payload!.data.content)
    expect(card.elements[0].content).toContain('<at id="ou_peer"></at>')
    expect(card.elements[0].content).toContain('reply.md')
    expect(card.elements.at(-1).elements[0].content).toBe('10k')
    return { code: 0 }
  }
  try {
    expect(await adapter.edit!('om_original_card', { ...message, partial: false })).toEqual({
      status: 'sent',
      messageId: 'om_original_card',
    })
  } finally {
    await adapter.stop()
  }
})

test('Lark uses explicit chat and user access and keeps regions separate', async () => {
  const adapter = lark(options)
  const overseas = lark({ ...options, domain: 'lark' })
  try {
    expect(adapter.canAccess(address)).toBe(true)
    expect(adapter.canAccess({ ...address, id: 'channel:oc_other' })).toBe(false)
    expect(adapter.canAccess({ id: 'dm:ou_human:oc_dm', title: 'DM', kind: 'direct' })).toBe(true)
    expect(adapter.canAccess({ id: 'dm:ou_other:oc_dm', title: 'DM', kind: 'direct' })).toBe(false)
    expect(adapter.conversationKey?.(address)).toBe('feishu:channel:oc_group')
    expect(overseas.conversationKey?.(address)).toBe('lark:channel:oc_group')
    expect(adapter.conversationKey?.({ id: 'dm:ou_human:oc_dm', title: 'DM', kind: 'direct' })).toBeUndefined()
    expect(
      (await adapter.send({ id: 'denied', address: { ...address, id: 'channel:oc_other' }, text: 'hello' })).status
    ).toBe('failed')
  } finally {
    await adapter.stop()
    await overseas.stop()
  }
})

test('Lark connects with platform identity and acknowledges independently of model processing', async () => {
  const adapter = lark(options)
  const received: IncomingMessage[] = []
  const states: string[] = []
  adapter.native.client.request = async () => ({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Bot' } }) as never
  adapter.native.socket.start = async () => {
    ;(adapter.native.socket as unknown as { onReady(): void }).onReady()
  }
  try {
    await adapter.start({
      receive: async (message) => {
        received.push(message)
      },
      status: (status) => {
        states.push(status.state)
      },
      echo: () => {},
    })
    expect(adapter.identity).toEqual({ id: 'ou_bot', name: 'Bot' })
    const handler = adapter.native.dispatcher.handles.get('im.message.receive_v1')!
    expect(handler(event())).toBeUndefined()
    expect(received).toHaveLength(1)
    handler({ ...event(), sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' } })
    expect(received).toHaveLength(1)
    expect(states).toEqual(['connecting', 'connected'])
  } finally {
    await adapter.stop()
  }
})

test('Lark uploads attachments before native delivery and preserves stable UUIDs and uncertain failures', async () => {
  const adapter = lark(options)
  const calls: string[] = []
  const payloads: unknown[] = []
  adapter.native.client.im.file.create = async (payload) => {
    calls.push('upload')
    expect(payload?.data.file_name).toBe('answer.txt')
    return { file_key: 'file_uploaded' }
  }
  adapter.native.client.im.message.create = async (payload) => {
    calls.push('send')
    payloads.push(payload)
    return { code: 0, data: { message_id: 'om_sent' } }
  }
  try {
    const message = {
      id: 'stable-output',
      address,
      text: '',
      files: [{ uri: 'data:text/plain;base64,aGVsbG8=', name: 'answer.txt' }],
    }
    expect(await adapter.send(message)).toEqual({ status: 'sent', messageId: 'om_sent' })
    expect(calls).toEqual(['upload', 'send'])
    expect(payloads[0]).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_group', msg_type: 'file', content: '{"file_key":"file_uploaded"}' },
    })
    await adapter.send({ id: message.id, address, text: 'retry' })
    expect((payloads[0] as { data: { uuid: string } }).data.uuid).toBe(
      (payloads[1] as { data: { uuid: string } }).data.uuid
    )

    adapter.native.client.im.message.patch = async (payload) => {
      expect(payload?.path.message_id).toBe('om_sent')
      expect(JSON.parse(payload!.data.content).elements.at(-1).tag).toBe('note')
      return { code: 0 }
    }
    expect(await adapter.edit!('om_sent', { id: 'edit', address, text: 'done', notes: ['2 Tokens'] })).toEqual({
      status: 'sent',
      messageId: 'om_sent',
    })
    adapter.native.client.im.message.create = async () => {
      throw new Error('connection reset')
    }
    expect((await adapter.send({ id: 'unknown', address, text: 'hello' })).status).toBe('unknown')
    adapter.native.client.im.message.create = async () => ({ code: 230013, msg: 'no permission' })
    expect((await adapter.send({ id: 'rejected', address, text: 'hello' })).status).toBe('failed')
  } finally {
    await adapter.stop()
  }
})

test('Lark downloads message resources with authentication and caches local materialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ineffa-lark-'))
  const adapter = lark({ ...options, directory })
  let downloads = 0
  adapter.native.client.im.messageResource.get = async (payload) => {
    expect(payload).toEqual({ path: { message_id: 'om_received', file_key: 'img_key' }, params: { type: 'image' } })
    downloads++
    return {
      getReadableStream: () => Readable.from([Buffer.from('image bytes')]),
      writeFile: async () => {},
      headers: {},
    }
  }
  try {
    const message = larkMessage({
      ...event(),
      message: { ...event().message, message_type: 'image', content: '{"image_key":"img_key"}' },
    })!
    expect(message.files?.[0]?.uri).toBe('lark-asset://resource/om_received/img_key?type=image')
    const files = await adapter.prepareAttachments!(message.files!)
    expect(await Bun.file(fileURLToPath(files[0]!.uri)).text()).toBe('image bytes')
    await adapter.prepareAttachments!(message.files!)
    expect(downloads).toBe(1)
    await expect(adapter.prepareAttachments!([{ uri: 'https://untrusted.example/file' }])).rejects.toThrow(
      '飞书消息资源'
    )
  } finally {
    await adapter.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Lark history preserves bot identity and checks the before-message conversation', async () => {
  const adapter = lark(options)
  adapter.native.client.im.message.get = async () => ({
    code: 0,
    data: { items: [{ message_id: 'om_before', chat_id: 'oc_group', create_time: '1500' }] },
  })
  adapter.native.client.im.message.list = async (payload) => {
    expect(payload?.params).toMatchObject({ container_id: 'oc_group', end_time: '2' })
    return {
      code: 0,
      data: {
        items: [
          {
            message_id: 'om_later',
            create_time: '1600',
            sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user' },
          },
          {
            message_id: 'om_earlier',
            msg_type: 'text',
            create_time: '1400',
            sender: {
              id: 'cli_0123456789abcdef',
              id_type: 'app_id',
              sender_type: 'app',
              open_bot_id: 'ou_peer',
              sender_name: 'Peer',
            },
            body: { content: '{"text":"hello @_user_1"}' },
            mentions: [{ key: '@_user_1', id: 'ou_human', id_type: 'open_id', name: 'Human' }],
          },
        ],
      },
    }
  }
  try {
    const messages = await adapter.readHistory!(address, 'om_before')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.author).toEqual({ id: 'ou_peer', name: 'Peer', bot: true })
    expect(messages[0]?.mentions).toEqual(['ou_human'])
    adapter.native.client.im.message.get = async () => ({
      code: 0,
      data: { items: [{ message_id: 'om_before', chat_id: 'oc_other', create_time: '1500' }] },
    })
    await expect(adapter.readHistory!(address, 'om_before')).rejects.toThrow('不属于此会话')
  } finally {
    await adapter.stop()
  }
})

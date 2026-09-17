import { expect, spyOn, test } from 'bun:test'
import { kook } from 'ineffa-kook'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TestAdapter, fixture, human, until } from './fixture'

import { kookContent, prepareKookAttachments } from '../packages/ineffa-kook/src/attachments'
import { snapshotFile } from '../packages/ineffa/src/files'
import { AccountsConfig } from '../src/config'
import { createServer } from '../src/server'

test('KOOK extracts image metadata and modern file cards, without downloading arbitrary links', () => {
  expect(
    kookContent(2, 'https://img.kaiheila.cn/old.png', {
      url: 'https://img.kookapp.cn/image.png',
      name: '图片.png',
    })
  ).toEqual({ text: '', files: [{ uri: 'https://img.kookapp.cn/image.png', name: '图片.png', mime: 'image/png' }] })
  const content = JSON.stringify([
    {
      type: 'card',
      modules: [
        { type: 'section', text: { type: 'kmarkdown', content: '(met)123(met) 文件在这里' } },
        { type: 'file', src: 'https://img.kaiheila.cn/report.txt', title: 'report.txt' },
        { type: 'container', elements: [{ type: 'image', src: 'https://img.kookapp.cn/a.jpg', alt: 'a.jpg' }] },
        {
          type: 'action-group',
          elements: [{ type: 'button', value: 'http://127.0.0.1/secret', click: 'link', text: 'link' }],
        },
        { type: 'file', src: 'file:///etc/passwd', title: 'secret' },
        { type: 'file', src: 'https://img.kookapp.cn.evil.example/secret', title: 'secret' },
      ],
    },
  ])
  const result = kookContent(10, content)
  expect(result.text).toBe('(met)123(met) 文件在这里')
  expect(result.files?.map((file) => file.name)).toEqual(['report.txt', 'a.jpg'])
  expect(kookContent(10, '{broken').text).toContain('无法解析')
  expect(kookContent(4, 'https://img.kookapp.cn/f', { name: '..' }).files?.[0]?.name).toBe('attachment')
})

test('KOOK uploads image and file before sending visible card modules in channels and DMs', async () => {
  const adapter = kook({ id: 'files', token: 'test', directory: '.', channels: ['123'], users: ['456'] })
  const uploads: File[] = []
  const sent: { type?: number; content: string; target_id?: string }[] = []
  adapter.native.api.uploadAsset = async (data) => {
    const file = data.get('file') as File
    uploads.push(file)
    return { success: true, data: { url: `https://img.kookapp.cn/${file.name}` } } as never
  }
  adapter.native.api.createMessage = adapter.native.api.createDirectMessage = async (props) => {
    sent.push(props)
    return { success: true, data: { msg_id: 'sent' } } as never
  }
  const files = [
    { uri: 'data:image/png;base64,aW1hZ2U=', mime: 'image/png', name: 'image.png' },
    { uri: 'data:text/plain;base64,ZmlsZQ==', mime: 'text/plain', name: 'file.txt' },
  ]
  for (const address of [
    { id: 'channel:g:123', kind: 'channel' as const, title: 'channel' },
    { id: 'dm:456', kind: 'direct' as const, title: 'DM' },
  ]) {
    expect((await adapter.send({ id: 'files', address, text: '附件', files })).status).toBe('sent')
    const message = sent.at(-1)!
    expect(message.type).toBe(10)
    expect(message.target_id).toBe(address.id.split(':').at(-1)!)
    const modules = JSON.parse(message.content)[0].modules
    expect(modules).toContainEqual({
      type: 'container',
      elements: [{ type: 'image', src: 'https://img.kookapp.cn/image.png', alt: 'image.png' }],
    })
    expect(modules).toContainEqual({ type: 'file', src: 'https://img.kookapp.cn/file.txt', title: 'file.txt' })
  }
  expect(await uploads[1]!.text()).toBe('file')
  adapter.native.api.uploadAsset = async () => ({ success: false, code: 403, message: 'denied' }) as never
  expect(
    (await adapter.send({ id: 'failed', address: { id: 'dm:456', kind: 'direct', title: 'DM' }, text: '', files }))
      .status
  ).toBe('failed')
  expect(sent).toHaveLength(2)
})

test('downloaded KOOK files enter the real engine with bounded bytes and stable workspace paths', async () => {
  const f = await fixture(() => 'READ')
  try {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ATTACHMENT_TEXT', { headers: { 'content-type': 'text/plain' } })
    )
    let files
    try {
      files = await prepareKookAttachments(f.workspace, [
        { uri: 'https://img.kookapp.cn/test.txt', name: 'test.txt', mime: 'text/plain' },
      ])
      expect(await Bun.file(fileURLToPath(files[0]!.uri)).text()).toBe('ATTACHMENT_TEXT')
      await prepareKookAttachments(f.workspace, [{ uri: 'https://img.kookapp.cn/test.txt', name: 'test.txt' }])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      fetchSpy.mockResolvedValue(new Response('too big', { headers: { 'content-length': String(21 * 1024 * 1024) } }))
      await expect(prepareKookAttachments(f.workspace, [{ uri: 'https://img.kookapp.cn/large.bin' }])).rejects.toThrow(
        '20 MiB'
      )
      await expect(prepareKookAttachments(f.workspace, [{ uri: 'http://127.0.0.1/private' }])).rejects.toThrow('KOOK')
    } finally {
      fetchSpy.mockRestore()
    }
    const a = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(a)
    await f.host.receive('A', { ...human('files', '读取附件'), files })
    await until(() => a.sent.some((message) => message.text === 'READ'))
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('ATTACHMENT_TEXT')
  } finally {
    await f.close()
  }
}, 30_000)

test('send_file honors native permissions and surfaces a pending approval on the platform', async () => {
  const f = await fixture((request) =>
    request.messages.some((message) => message.role === 'tool')
      ? 'DONE'
      : { tool: 'send_file', input: { path: 'report.txt' } }
  )
  try {
    const a = new TestAdapter('A', f.workspace)
    a.capabilities.attachments = true
    await f.host.addAdapter(a)
    await Bun.write(join(f.workspace, 'report.txt'), 'REPORT')
    const binding = await f.host.createConversation('A', human('source', '').address)
    await f.engine.native.permission.rules({
      sessionID: binding.sessionId,
      permissions: [{ action: 'send_file', resource: '*', effect: 'ask' }],
    })
    await f.host.receive('A', human('send', '发送报告'))
    await until(() => a.sent.some((message) => message.text.includes('需要权限确认')))
    expect(a.sent.some((message) => message.files?.length)).toBe(false)
    const permission = (await f.engine.native.permission.list({ sessionID: binding.sessionId }))[0]!
    await f.engine.native.permission.reply({ sessionID: binding.sessionId, requestID: permission.id, reply: 'once' })
    await until(() => a.sent.some((message) => message.text === 'DONE'))
    expect(a.sent.filter((message) => message.files?.length)).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 30_000)

test('send_file is model-callable, snapshots delivery and refuses paths outside the workspace', async () => {
  const f = await fixture((request) =>
    request.messages.some((message) => message.role === 'tool')
      ? 'DONE'
      : { tool: 'send_file', input: { path: 'report.txt', caption: '报告' } }
  )
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
    token: 'file-test',
  })
  try {
    const a = new TestAdapter('A', f.workspace)
    a.capabilities.attachments = true
    await f.host.addAdapter(a)
    await Bun.write(join(f.workspace, 'report.txt'), 'REPORT')
    await f.host.receive('A', human('send', '发送报告'))
    await until(() => a.sent.some((message) => message.text === 'DONE'))
    const sent = a.sent.find((message) => message.files?.length)!
    expect(sent).toBeDefined()
    expect(sent.files![0]!.name).toBe('report.txt')
    expect(await Bun.file(fileURLToPath(sent.files![0]!.uri)).text()).toBe('REPORT')
    await Bun.write(join(f.workspace, 'report.txt'), 'CHANGED')
    await f.host.delivery.enqueue(sent.id)
    expect(a.sent.filter((message) => message.files?.length)).toHaveLength(1)
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('附件已发送')
    const url = `http://127.0.0.1:${app.server.port}/api/attachments/${sent.id}/0`
    expect((await fetch(url)).status).toBe(401)
    const download = await fetch(url, { headers: { Authorization: 'Bearer file-test' } })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('attachment;')
    expect(download.headers.get('cache-control')).toBe('no-store')
    expect(await download.text()).toBe('REPORT')
    await Bun.write(join(f.directory, 'private.txt'), 'private')
    expect(await Bun.file(fileURLToPath(sent.files![0]!.uri)).text()).toBe('REPORT')
    await expect(snapshotFile(f.workspace, '../private.txt', join(f.directory, 'snapshots'))).rejects.toThrow(
      '工作目录'
    )
  } finally {
    await app.close()
    await f.close()
  }
}, 30_000)

import type { Attachment } from 'ineffa'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Client } from '@larksuiteoapi/node-sdk'

const maxBytes = 20 * 1024 * 1024

function filename(value: string | undefined) {
  return (
    basename((value || 'attachment').replaceAll('\\', '/'))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 150)
      .replace(/[. ]+$/g, '') || 'attachment'
  )
}

/** Message resource downloads are authenticated; a platform key is never a public URL. */
export async function prepareLarkAttachments(client: Client, directory: string, files: Attachment[]) {
  const result: Attachment[] = []
  for (const file of files) {
    if (file.uri.startsWith('file:') || file.uri.startsWith('data:')) {
      result.push(file)
      continue
    }
    const uri = new URL(file.uri)
    const parts = uri.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const type = uri.searchParams.get('type')
    if (
      uri.protocol !== 'lark-asset:' ||
      uri.hostname !== 'resource' ||
      parts.length !== 2 ||
      !['image', 'file'].includes(type || '')
    ) {
      throw new Error('附件必须使用飞书消息资源。')
    }
    const key = createHash('sha256').update(file.uri).digest('hex')
    const folder = join(directory, '.ineffa-attachments', key)
    const path = join(folder, filename(file.name))
    if (!(await Bun.file(path).exists())) {
      const response = await client.im.messageResource.get({
        path: { message_id: parts[0]!, file_key: parts[1]! },
        params: { type: type! },
      })
      const stream = response.getReadableStream()
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.byteLength
          if (size > maxBytes) throw new Error('附件超过 20 MiB。')
          chunks.push(bytes)
        }
      } finally {
        stream.destroy()
      }
      await mkdir(folder, { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      await Bun.write(temporary, Buffer.concat(chunks, size))
      await rename(temporary, path)
    }
    result.push({ ...file, uri: pathToFileURL(path).href, mime: file.mime || Bun.file(path).type || undefined })
  }
  return result
}

export async function uploadLarkAttachment(client: Client, file: Attachment) {
  let bytes: Buffer
  let mime = file.mime
  if (file.uri.startsWith('file:')) {
    const local = Bun.file(fileURLToPath(file.uri))
    if (local.size > maxBytes) throw new Error('附件超过 20 MiB。')
    bytes = Buffer.from(await local.arrayBuffer())
    mime ||= local.type
  } else if (file.uri.startsWith('data:')) {
    if (file.uri.length > maxBytes * 1.4) throw new Error('附件超过 20 MiB。')
    const response = await fetch(file.uri)
    bytes = Buffer.from(await response.arrayBuffer())
    mime ||= response.headers.get('content-type') || undefined
  } else throw new Error('发送附件需要本地文件或 data URI。')
  if (bytes.byteLength > maxBytes) throw new Error('附件超过 20 MiB。')

  if (mime?.startsWith('image/')) {
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('飞书图片不能超过 10 MiB。')
    const result = await client.im.image.create({ data: { image_type: 'message', image: bytes } })
    if (!result?.image_key) throw new Error('飞书图片上传失败，未返回图片 Key。')
    return { msg_type: 'image', content: JSON.stringify({ image_key: result.image_key }) }
  }
  const result = await client.im.file.create({
    data: { file_type: 'stream', file_name: filename(file.name), file: bytes },
  })
  if (!result?.file_key) throw new Error('飞书文件上传失败，未返回文件 Key。')
  return { msg_type: 'file', content: JSON.stringify({ file_key: result.file_key }) }
}

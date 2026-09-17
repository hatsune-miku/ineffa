import type { Attachment, OutgoingMessage } from 'ineffa'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { KookClient } from '@kookapp/js-sdk'

const maxBytes = 20 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif'])
type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
}

function assetUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  try {
    const url = new URL(value)
    const allowed = ['kookapp.cn', 'kookapp.com', 'kaiheila.cn'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && allowed) return url.href
  } catch {}
}

function filename(value: unknown, uri: string): string {
  const fallback = new URL(uri).pathname.split('/').at(-1) || 'attachment'
  const name = typeof value === 'string' && value.trim() ? value : fallback
  return (
    basename(name.replaceAll('\\', '/'))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 150)
      .replace(/[. ]+$/g, '') || 'attachment'
  )
}

/** Only media elements carry attachments; links and buttons are not downloaded. */
export function kookContent(type: number, content: string, metadata?: unknown): { text: string; files?: Attachment[] } {
  const files: Attachment[] = []
  const texts: string[] = []
  function addFile(source: unknown, name?: unknown, mime?: unknown) {
    const uri = assetUrl(source)
    if (!uri || files.some((file) => file.uri === uri)) return
    if (files.length >= 10) throw new Error('单条消息最多接收 10 个附件。')
    const title = filename(name, uri)
    files.push({
      uri,
      name: title,
      mime: typeof mime === 'string' && mime.includes('/') ? mime : Bun.file(title).type || undefined,
    })
  }
  function visit(value: unknown) {
    const item = object(value)
    if (item.type === 'plain-text' || item.type === 'kmarkdown') {
      if (typeof item.content === 'string') texts.push(item.content)
    } else if (item.type === 'image') addFile(item.src, item.alt)
    else if (['file', 'audio', 'video'].includes(String(item.type))) addFile(item.src, item.title)
    else if (item.type === 'paragraph' && Array.isArray(item.fields)) item.fields.forEach(visit)
  }
  if (type === 10) {
    let cards: unknown
    try {
      cards = JSON.parse(content)
    } catch {
      return { text: '[无法解析的卡片]' }
    }
    if (!Array.isArray(cards)) return { text: '[无法解析的卡片]' }
    for (const card of cards.slice(0, 5)) {
      const modules = object(card).modules
      if (!Array.isArray(modules)) continue
      for (const value of modules.slice(0, 50)) {
        const module = object(value)
        visit(module)
        if (typeof module.text === 'string') texts.push(module.text)
        else visit(module.text)
        visit(module.accessory)
        if (Array.isArray(module.elements)) module.elements.forEach(visit)
      }
    }
  } else if ([2, 3, 4, 8].includes(type)) {
    const attachment = object(metadata)
    addFile(attachment.url ?? content, attachment.name, attachment.file_type)
  } else {
    return { text: content }
  }
  if (!texts.length && !files.length) texts.push('[不支持的附件或卡片]')
  return { text: texts.join('\n'), files: files.length ? files : undefined }
}

export async function prepareKookAttachments(directory: string, files: Attachment[]): Promise<Attachment[]> {
  const result: Attachment[] = []
  for (const file of files) {
    // Local peer deliveries already contain a snapshot. Gateway normalization never accepts these URIs.
    if (file.uri.startsWith('file:') || file.uri.startsWith('data:')) {
      result.push(file)
      continue
    }
    const uri = assetUrl(file.uri)
    if (!uri) throw new Error('附件必须使用 KOOK 媒体地址。')
    const key = createHash('sha256').update(uri).digest('hex')
    const folder = join(directory, '.ineffa-attachments', key)
    const path = join(folder, filename(file.name, uri))
    if (!(await Bun.file(path).exists())) {
      const response = await fetch(uri, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`附件下载失败：HTTP ${response.status}`)
      const bytes = await boundedBody(response)
      await mkdir(folder, { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      await Bun.write(temporary, bytes)
      await rename(temporary, path)
    }
    result.push({ ...file, uri: pathToFileURL(path).href })
  }
  return result
}

async function boundedBody(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('附件内容为空。')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('附件超过 20 MiB。')
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('附件超过 20 MiB。')
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function sourceFile(file: Attachment): Promise<File> {
  let blob: Blob
  if (file.uri.startsWith('data:')) {
    if (file.uri.length > maxBytes * 1.4) throw new Error('附件超过 20 MiB。')
    const response = await fetch(file.uri)
    blob = new Blob([await boundedBody(response)], { type: file.mime || response.headers.get('content-type') || '' })
  } else if (file.uri.startsWith('file:')) {
    const local = Bun.file(fileURLToPath(file.uri))
    if (local.size > maxBytes) throw new Error('附件超过 20 MiB。')
    blob = local
  } else {
    throw new Error('发送附件需要本地文件或 data URI；请先下载远端文件。')
  }
  if (blob.size > maxBytes) throw new Error('附件超过 20 MiB。')
  return new File([blob], file.name || 'attachment', { type: file.mime || blob.type || 'application/octet-stream' })
}

/** Start with a card so later edits can add file modules without changing the message type. */
export async function kookCard(client: KookClient, message: OutgoingMessage, mentions: (text: string) => string[]) {
  const modules: ObjectValue[] = []
  async function upload(file: File) {
    const data = new FormData()
    data.append('file', file)
    const asset = await client.api.uploadAsset(data)
    if (!asset.success || !asset.data?.url || !/^https:\/\//.test(asset.data.url)) throw new Error('附件上传失败。')
    if (imageTypes.has(file.type)) {
      modules.push({ type: 'container', elements: [{ type: 'image', src: asset.data.url, alt: file.name }] })
    } else {
      modules.push({ type: 'file', src: asset.data.url, title: file.name })
    }
  }
  function sections(text: string) {
    for (let offset = 0; offset < text.length; offset += 4_000) {
      modules.push({ type: 'section', text: { type: 'kmarkdown', content: text.slice(offset, offset + 4_000) } })
    }
  }
  function serialize() {
    return JSON.stringify([{ type: 'card', theme: 'none', size: 'lg', modules }])
  }
  let text = message.partial ? message.text.slice(0, 7_000) : message.text
  sections(text)
  if (text.length > 7_000 || serialize().length > 7_800) {
    modules.length = 0
    if (message.partial) {
      while (text.length && JSON.stringify(text).length > 7_000) text = text.slice(0, -500)
      sections(text)
    } else {
      sections(
        mentions(text)
          .map((id) => `(met)${id}(met)`)
          .join(' ')
      )
      await upload(new File([text], 'reply.md', { type: 'text/markdown' }))
    }
  }
  const files = message.partial ? [] : (message.files ?? [])
  if (files.length > 10) throw new Error('单条消息最多发送 10 个附件。')
  for (const file of files) await upload(await sourceFile(file))
  if (!modules.length) sections('…')
  const content = serialize()
  if (content.length > 8_000) throw new Error('卡片超过 KOOK 消息长度限制，请减少附件或说明文字。')
  return content
}

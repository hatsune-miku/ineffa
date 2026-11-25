import type { Attachment, IncomingMessage, OutgoingMessage } from 'ineffa'

import type {
  EventHandles,
  InteractiveCard,
  InteractiveCardElement,
  InteractiveCardMarkdownElement,
} from '@larksuiteoapi/node-sdk'

export type MessageEvent = Parameters<NonNullable<EventHandles['im.message.receive_v1']>>[0]
type ObjectValue = Record<string, unknown>

export class LarkCardTooLong extends Error {
  constructor() {
    super('飞书卡片过长。')
  }
}

function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
}

function escapeAttribute(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function larkMention(id: string) {
  return `<at id="${escapeAttribute(id)}"></at>`
}

/** Only native mentions in visible prose can wake another account. */
export function larkMentions(text: string): string[] {
  const visible = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^\s*>.*$/gm, '')
  return [
    ...new Set(
      [...visible.matchAll(/(?<!\\)<at\s+id=["']([\w-]+)["'][^>]*>[\s\S]*?<\/at>/g)]
        .map((match) => match[1]!)
        .filter((id) => id !== 'all')
    ),
  ]
}

function content(event: MessageEvent) {
  const message = event.message
  let data: ObjectValue
  try {
    data = object(JSON.parse(message.content))
  } catch {
    return { text: '[无法解析的消息]' }
  }
  const lines: string[] = []
  const files: Attachment[] = []
  function media(key: unknown, type: 'image' | 'file', name?: unknown) {
    if (typeof key !== 'string' || !key || files.length >= 10) return
    const uri = `lark-asset://resource/${encodeURIComponent(message.message_id)}/${encodeURIComponent(key)}?type=${type}`
    if (files.some((file) => file.uri === uri)) return
    files.push({ uri, name: typeof name === 'string' ? name : type === 'image' ? 'image.png' : 'attachment' })
  }
  function element(value: unknown) {
    const item = object(value)
    if (item.tag === 'text' && typeof item.text === 'string') lines.push(item.text)
    else if (item.tag === 'a' && typeof item.href === 'string') lines.push(`${item.text || item.href} (${item.href})`)
    else if (item.tag === 'at' && typeof item.user_id === 'string') lines.push(larkMention(item.user_id))
    else if (item.tag === 'img') media(item.image_key, 'image')
    else if (item.tag === 'media') media(item.file_key, 'file', item.file_name)
    else if (item.tag === 'md' && typeof item.text === 'string') lines.push(item.text)
    else if (item.tag === 'markdown' && typeof item.content === 'string') lines.push(item.content)
    else if (item.tag === 'div') {
      const text = object(item.text)
      if (typeof text.content === 'string') lines.push(text.content)
    }
  }
  if (message.message_type === 'text') lines.push(typeof data.text === 'string' ? data.text : '')
  else if (message.message_type === 'image') media(data.image_key, 'image')
  else if (['file', 'audio', 'media'].includes(message.message_type)) media(data.file_key, 'file', data.file_name)
  else if (message.message_type === 'post') {
    const post = Array.isArray(data.content) ? data : object(data.zh_cn ?? data.en_us ?? Object.values(data)[0])
    if (typeof post.title === 'string' && post.title) lines.push(post.title)
    if (Array.isArray(post.content)) {
      for (const row of post.content) {
        if (Array.isArray(row)) row.forEach(element)
      }
    }
  } else if (message.message_type === 'interactive') {
    // Display-only card notes are deliberately omitted from the conversation.
    const elements = object(data.body).elements ?? data.elements
    if (Array.isArray(elements)) elements.forEach(element)
  } else lines.push(`[${message.message_type} 消息]`)

  let text = lines.join('\n')
  for (const mention of message.mentions ?? []) {
    if (mention.id.open_id && mention.key) text = text.replaceAll(mention.key, larkMention(mention.id.open_id))
  }
  return { text, files: files.length ? files : undefined }
}

export function larkMessage(event: MessageEvent): IncomingMessage | undefined {
  const message = event.message
  const sender = event.sender.sender_id?.open_id
  if (!sender || !message.message_id || !message.chat_id || !['p2p', 'group'].includes(message.chat_type)) return
  const direct = message.chat_type === 'p2p'
  const body = content(event)
  const authorName = message.mentions?.find((mention) => mention.id.open_id === sender)?.name || sender
  return {
    id: message.message_id,
    address: {
      id: direct ? `dm:${sender}:${message.chat_id}` : `channel:${message.chat_id}`,
      title: direct ? authorName : message.chat_id,
      kind: direct ? 'direct' : 'channel',
    },
    author: { id: sender, name: authorName, bot: event.sender.sender_type !== 'user' },
    text: body.text,
    files: body.files,
    mentions: larkMentions(body.text).filter((id) => message.mentions?.some((mention) => mention.id.open_id === id)),
    quoteId: message.parent_id,
    createdAt: Number(message.create_time) || Date.now(),
  }
}

export function larkCard(message: OutgoingMessage): string {
  // V1 supports markdown + hr + note; retain the SDK's card types to avoid mixing V2-only fields.
  const body: InteractiveCardMarkdownElement = { tag: 'markdown', content: message.text || '…' }
  const elements: InteractiveCardElement[] = [body]
  const notes = message.notes?.filter((note) => note.trim()) ?? []
  if (notes.length) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'note', elements: notes.map((note) => ({ tag: 'plain_text', content: note })) })
  }
  function serialize() {
    const card: InteractiveCard = { config: { wide_screen_mode: true, update_multi: true }, elements }
    return JSON.stringify(card)
  }
  if (Buffer.byteLength(serialize()) <= 28_000) return serialize()
  if (!message.partial) throw new LarkCardTooLong()
  let low = 0
  let high = message.text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    body.content = `${message.text.slice(0, middle)}…`
    if (Buffer.byteLength(serialize()) <= 28_000) low = middle
    else high = middle - 1
  }
  body.content = `${message.text.slice(0, low)}…`
  if (Buffer.byteLength(serialize()) > 28_000) throw new LarkCardTooLong()
  return serialize()
}

import {
  type AccountProfile,
  type Adapter,
  type AdapterContext,
  type Address,
  type IncomingMessage,
  type OutgoingMessage,
  type SendResult,
  errorMessage,
  modelReference,
  validateAgentPrompt,
} from 'ineffa'
import { resolve } from 'node:path'

import { type KEvent, type KResponseExt, type KTextChannelExtra, KookClient } from '@kookapp/js-sdk'

import { kookCard, kookContent, prepareKookAttachments } from './attachments'

export interface KookOptions extends AccountProfile {
  id: string
  token: string
  agent?: string
  directory: string
  guilds?: string[]
  channels?: string[]
  users?: string[]
}

/** Recognize native mentions outside code, quoted blocks and escaped syntax. */
export function kookMentions(text: string): string[] {
  const visible = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^\s*>.*$/gm, '')
  return [...new Set([...visible.matchAll(/(?<!\\)\(met\)(\d+)\(met\)/g)].map((match) => match[1]!))]
}
function failure(result: KResponseExt<unknown>): SendResult {
  // The SDK synthesizes 408/499/1145 for transport failures. These do not prove rejection.
  const ambiguous =
    result.code <= 0 || [408, 499, 1145].includes(result.code) || (result.code >= 500 && result.code < 600)
  return { status: ambiguous ? 'unknown' : 'failed', error: `KOOK ${result.code}: ${result.message}` }
}

export function kook(options: KookOptions): Adapter & { native: KookClient } {
  if (!options.token?.trim()) throw new Error(`账号 ${options.id} 缺少 KOOK Token。`)
  if (
    [...(options.guilds ?? []), ...(options.channels ?? []), ...(options.users ?? [])].some((id) => !/^\d+$/.test(id))
  )
    throw new Error(`账号 ${options.id} 的服务器、频道和用户列表必须使用 KOOK 数字 ID。`)
  const client = new KookClient({ botToken: options.token })
  let agentPrompt = validateAgentPrompt(options.agentPrompt)
  modelReference(options.model)
  let model = options.model?.trim() || undefined
  let displayName = options.name?.trim() || options.id
  let context: AdapterContext | undefined
  let attached = false
  const guilds = new Set(options.guilds ?? [])
  const channels = new Set(options.channels ?? [])
  const users = new Set(options.users ?? [])
  function canAccess(address: Address) {
    if (address.kind === 'direct') return users.has(address.id.slice(3))
    const parts = address.id.split(':')
    const guildId = address.guildId ?? (parts.length === 3 ? parts[1] : undefined)
    return (guildId !== undefined && guilds.has(guildId)) || channels.has(parts.at(-1)!)
  }
  function normalize(event: KEvent<KTextChannelExtra>): IncomingMessage | undefined {
    const direct = event.channel_type === 'PERSON'
    if (event.channel_type !== 'GROUP' && !direct) return
    if (![1, 2, 3, 4, 8, 9, 10].includes(event.type)) return
    const extra = event.extra
    const address: Address = direct
      ? { id: `dm:${event.author_id}`, title: extra.author?.username ?? event.author_id, kind: 'direct' }
      : {
          id: `channel:${extra.guild_id}:${event.target_id}`,
          title: extra.channel_name ?? event.target_id,
          kind: 'channel',
          guildId: extra.guild_id,
        }
    const content = kookContent(event.type, event.content, (extra as unknown as { attachments?: unknown }).attachments)
    const quote = (
      extra as unknown as {
        quote?: {
          id?: string
          content?: string
          author?: { id: string; username?: string; nickname?: string; bot?: boolean }
        }
      }
    ).quote
    return {
      id: event.msg_id,
      address,
      author: {
        id: event.author_id,
        name: extra.author?.nickname || extra.author?.username || event.author_id,
        bot: Boolean(extra.author?.bot),
      },
      text: content.text,
      mentions: (extra.mention ?? []).filter((id) => kookMentions(content.text).includes(id)),
      createdAt: event.msg_timestamp,
      quote: quote?.content,
      quoteId: quote?.id,
      quoteAuthor: quote?.author?.id
        ? {
            id: quote.author.id,
            name: quote.author.nickname || quote.author.username || quote.author.id,
            bot: Boolean(quote.author.bot),
          }
        : undefined,
      files: content.files,
    }
  }
  const adapter: Adapter & { native: KookClient } = {
    id: options.id,
    get name() {
      return displayName
    },
    platform: 'kook',
    agent: options.agent ?? 'build',
    directory: resolve(options.directory),
    get agentPrompt() {
      return agentPrompt
    },
    get model() {
      return model
    },
    updateProfile(profile) {
      const nextPrompt = validateAgentPrompt(profile.agentPrompt)
      modelReference(profile.model)
      displayName = profile.name?.trim() || options.id
      agentPrompt = nextPrompt
      model = profile.model?.trim() || undefined
    },
    native: client,
    get identity() {
      return client.me ? { id: client.me.id, name: client.me.username } : undefined
    },
    capabilities: { edit: true, attachments: true, history: true },
    canAccess,
    conversationKey(address) {
      if (address.kind !== 'channel' || !canAccess(address)) return
      return `channel:${address.id.split(':').at(-1)}`
    },
    prepareAttachments: (files) => prepareKookAttachments(resolve(options.directory), files),
    mentions: kookMentions,
    mention: ({ id }) => `(met)${id}(met)`,
    async start(next) {
      context = next
      if (!attached) {
        attached = true
        client.on('textChannelEvent', (event) => {
          if (event.author_id === client.me?.id) {
            if (event.nonce) context?.echo(event.nonce, event.msg_id)
            return
          }
          const message = normalize(event)
          if (!message || !canAccess(message.address)) return
          void context
            ?.receive(message)
            .catch((error) => context?.status({ state: 'error', error: errorMessage(error) }))
        })
        client.on('reconnecting', () => context?.status({ state: 'connecting' }))
        client.on('stateChange', (state) => {
          if (state === 'CONNECTED') context?.status({ state: 'connected' })
        })
        client.on('close', () => context?.status({ state: 'disconnected' }))
        client.on('error', (message) => context?.status({ state: 'error', error: String(message) }))
      }
      await client.connect()
    },
    async stop() {
      client.disconnect()
      context?.status({ state: 'disconnected' })
    },
    async send(message: OutgoingMessage) {
      if (!canAccess(message.address)) return { status: 'failed', error: '服务器、频道或用户不在此账号的访问列表中。' }
      const target = message.address.id.split(':').at(-1)!
      let content: string
      try {
        content = await kookCard(client, message, kookMentions)
      } catch (error) {
        return { status: 'failed', error: errorMessage(error) }
      }
      const props = { type: 10 as const, target_id: target, content, nonce: message.id, quote: message.replyTo }
      const result =
        message.address.kind === 'direct'
          ? await client.api.createDirectMessage(props)
          : await client.api.createMessage(props)
      return result.success && result.data?.msg_id
        ? { status: 'sent', messageId: result.data.msg_id }
        : result.success
          ? { status: 'unknown', error: '平台返回成功，但未返回消息 ID。请在频道核实。' }
          : failure(result)
    },
    async edit(messageId, message) {
      if (!canAccess(message.address)) return { status: 'failed', error: '当前账号不允许访问此会话。' }
      let content: string
      try {
        content = await kookCard(client, message, kookMentions)
      } catch (error) {
        return { status: 'failed', error: errorMessage(error) }
      }
      const props = { msg_id: messageId, content }
      const result =
        message.address.kind === 'direct'
          ? await client.api.updateDirectMessage(props)
          : await client.api.updateMessage(props)
      return result.success ? { status: 'sent', messageId } : failure(result)
    },
    async readHistory(address, before) {
      if (!canAccess(address)) throw new Error('当前账号不允许读取此会话。')
      const target = address.id.split(':').at(-1)!
      const props = { target_id: target, msg_id: before, page_size: 50, flag: 'before' }
      const result =
        address.kind === 'direct' ? await client.api.listDirectMessages(props) : await client.api.listMessages(props)
      if (!result.success) throw new Error(`KOOK ${result.code}: ${result.message}`)
      const items = Array.isArray(result.data?.items) ? (result.data.items as Record<string, unknown>[]) : []
      return items.map((item) => {
        const author = (item.author ?? {}) as Record<string, unknown>
        const content = kookContent(Number(item.type ?? 9), String(item.content ?? ''), item.attachments)
        return {
          id: String(item.id ?? item.msg_id),
          address,
          author: { id: String(author.id), name: String(author.username ?? author.id), bot: Boolean(author.bot) },
          text: content.text,
          files: content.files,
          mentions: kookMentions(content.text),
          createdAt: Number(item.create_at ?? item.msg_timestamp ?? 0),
        }
      })
    },
  }
  return adapter
}

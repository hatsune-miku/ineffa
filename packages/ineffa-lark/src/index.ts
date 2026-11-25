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
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { Client, Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'

import { prepareLarkAttachments, uploadLarkAttachment } from './attachments'
import { LarkCardTooLong, type MessageEvent, larkCard, larkMention, larkMentions, larkMessage } from './content'

export { larkCard, larkMessage, larkMentions } from './content'

export interface LarkOptions extends AccountProfile {
  id: string
  appId: string
  appSecret: string
  directory: string
  agent?: string
  domain?: 'feishu' | 'lark'
  chats?: string[]
  users?: string[]
}

type ApiResponse = { code?: number; msg?: string; data?: { message_id?: string } }

function receipt(response: ApiResponse, messageId?: string): SendResult {
  if (response.code !== 0) return { status: 'failed', error: `飞书 ${response.code}: ${response.msg || '请求失败'}` }
  const id = response.data?.message_id || messageId
  return id ? { status: 'sent', messageId: id } : { status: 'unknown', error: '平台未返回消息 ID，请核实投递结果。' }
}

function transportFailure(error: unknown): SendResult {
  const response = (error as { response?: { status?: number; data?: ApiResponse } })?.response
  if (response?.status && response.status >= 400 && response.status < 500) {
    return {
      status: 'failed',
      error: `飞书 HTTP ${response.status}: ${response.data?.msg || '请求被拒绝'}`,
      retryAfterMs: response.status === 429 ? 1_000 : undefined,
    }
  }
  return { status: 'unknown', error: errorMessage(error) }
}

export function lark(options: LarkOptions): Adapter & {
  native: { client: Client; socket: WSClient; dispatcher: EventDispatcher }
} {
  if (!/^cli_[a-fA-F0-9]{16}$/.test(options.appId)) throw new Error('请输入有效的飞书 App ID。')
  if (!options.appSecret.trim()) throw new Error('请输入飞书 App Secret。')
  if (options.domain && !['feishu', 'lark'].includes(options.domain)) throw new Error('请选择飞书或 Lark。')
  if ((options.chats ?? []).some((id) => !/^oc_[\w-]+$/.test(id))) throw new Error('群聊 ID 应以 oc_ 开头。')
  if ((options.users ?? []).some((id) => !/^ou_[\w-]+$/.test(id)))
    throw new Error('用户 ID 应使用以 ou_ 开头的 Open ID。')
  const domain = options.domain === 'lark' ? Domain.Lark : Domain.Feishu
  const client = new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain,
    loggerLevel: LoggerLevel.warn,
  })
  const chats = new Set(options.chats ?? [])
  const users = new Set(options.users ?? [])
  const directory = resolve(options.directory)
  let context: AdapterContext | undefined
  let identity: Adapter['identity']
  let displayName = options.name?.trim() || options.id
  let agentPrompt = validateAgentPrompt(options.agentPrompt)
  let model = options.model?.trim() || undefined
  let backend = options.backend
  let connected: (() => void) | undefined
  let rejected: ((error: Error) => void) | undefined
  let stopped = true
  modelReference(model)

  const socket = new WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain,
    loggerLevel: LoggerLevel.warn,
    handshakeTimeoutMs: 15_000,
    wsConfig: { pingTimeout: 30 },
    onReady: () => {
      context?.status({ state: 'connected' })
      connected?.()
    },
    onError: (error) => {
      context?.status({ state: 'error', error: error.message })
      rejected?.(error)
    },
    onReconnecting: () => context?.status({ state: 'connecting' }),
    onReconnected: () => {
      context?.status({ state: 'connected' })
      connected?.()
    },
  })

  function canAccess(address: Address) {
    const parts = address.id.split(':')
    if (address.kind === 'direct') return parts[0] === 'dm' && parts.length === 3 && users.has(parts[1]!)
    return parts[0] === 'channel' && parts.length === 2 && chats.has(parts[1]!)
  }

  async function longReply(message: OutgoingMessage, messageId?: string): Promise<SendResult> {
    let payload: { msg_type: string; content: string }
    try {
      payload = await uploadLarkAttachment(client, {
        uri: `data:text/markdown;base64,${Buffer.from(message.text).toString('base64')}`,
        name: 'reply.md',
        mime: 'text/markdown',
      })
    } catch (error) {
      return { status: 'failed', error: errorMessage(error) }
    }
    const uuid = createHash('sha256').update(`${message.id}:long-reply`).digest('hex').slice(0, 32)
    const parent = messageId || message.replyTo
    let uploaded: SendResult
    try {
      uploaded = receipt(
        parent
          ? await client.im.message.reply({ path: { message_id: parent }, data: { ...payload, uuid } })
          : await client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: { ...payload, receive_id: message.address.id.split(':').at(-1)!, uuid },
            })
      )
    } catch (error) {
      return transportFailure(error)
    }
    if (uploaded.status !== 'sent') return uploaded
    const text = `${larkMentions(message.text).map(larkMention).join(' ')}\n完整回复见 reply.md。`.trim()
    try {
      const content = larkCard({ ...message, text })
      const result = messageId
        ? receipt(await client.im.message.patch({ path: { message_id: messageId }, data: { content } }), messageId)
        : receipt(
            await client.im.message.reply({
              path: { message_id: uploaded.messageId },
              data: { msg_type: 'interactive', content, uuid: `${uuid}-card` },
            })
          )
      if (result.status === 'sent') return result
    } catch {}
    return { status: 'unknown', error: `长回复附件已发送，但卡片更新未确认。附件消息 ID：${uploaded.messageId}` }
  }

  const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
    'im.message.receive_v1': (event) => {
      if (event.sender.sender_id?.open_id === identity?.id) return
      const message = larkMessage(event)
      if (!message || !canAccess(message.address)) return
      // Acknowledge the event without waiting for model work. Host persists and deduplicates the message ID.
      void context?.receive(message).catch((error) => context?.status({ state: 'error', error: errorMessage(error) }))
    },
  })

  const adapter: Adapter & { native: { client: Client; socket: WSClient; dispatcher: EventDispatcher } } = {
    id: options.id,
    get name() {
      return displayName
    },
    platform: options.domain === 'lark' ? 'lark' : 'feishu',
    agent: options.agent ?? 'build',
    directory,
    native: { client, socket, dispatcher },
    promptInstructions: '飞书回复使用 Markdown 和列表。提及用户或其他账号时使用 <at id="平台 Open ID"></at>。',
    get identity() {
      return identity
    },
    get agentPrompt() {
      return agentPrompt
    },
    get model() {
      return model
    },
    get backend() {
      return backend
    },
    updateProfile(profile) {
      const nextPrompt = validateAgentPrompt(profile.agentPrompt)
      modelReference(profile.model)
      displayName = profile.name?.trim() || options.id
      agentPrompt = nextPrompt
      model = profile.model?.trim() || undefined
      backend = profile.backend
    },
    capabilities: { edit: true, attachments: true, history: true },
    canAccess,
    conversationKey(address) {
      if (address.kind !== 'channel' || !canAccess(address)) return
      return `${options.domain || 'feishu'}:${address.id}`
    },
    mentions: larkMentions,
    mention: ({ id }) => larkMention(id),
    prepareAttachments: (files) => prepareLarkAttachments(client, directory, files),
    async start(next) {
      stopped = false
      context = next
      context.status({ state: 'connecting' })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const info = await client.request<{
          code: number
          msg?: string
          bot?: { open_id?: string; app_name?: string }
        }>({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
          timeout: 15_000,
        })
        if (stopped) throw new Error('飞书连接已停止。')
        if (info.code !== 0 || !info.bot?.open_id) throw new Error(`无法获取飞书机器人身份：${info.msg || info.code}`)
        identity = { id: info.bot.open_id, name: info.bot.app_name || displayName }
        const ready = new Promise<void>((resolve, reject) => {
          connected = resolve
          rejected = reject
        })
        timer = setTimeout(() => rejected?.(new Error('飞书长连接建立超时。')), 30_000)
        await socket.start({ eventDispatcher: dispatcher })
        await ready
      } catch (error) {
        socket.close({ force: true })
        throw error
      } finally {
        clearTimeout(timer)
        connected = undefined
        rejected = undefined
      }
    },
    async stop() {
      stopped = true
      rejected?.(new Error('飞书连接已停止。'))
      socket.close({ force: true })
      context?.status({ state: 'disconnected' })
      context = undefined
    },
    async send(message) {
      if (!canAccess(message.address)) return { status: 'failed', error: '此会话不在账号的访问列表中。' }
      let payload: { msg_type: string; content: string }
      try {
        if (message.files?.length) {
          if (message.files.length !== 1) throw new Error('请逐个发送飞书附件。')
          payload = await uploadLarkAttachment(client, message.files[0]!)
        } else payload = { msg_type: 'interactive', content: larkCard(message) }
      } catch (error) {
        if (error instanceof LarkCardTooLong && !message.files?.length) return longReply(message)
        return { status: 'failed', error: errorMessage(error) }
      }
      const uuid = createHash('sha256').update(message.id).digest('hex').slice(0, 32)
      try {
        let response: ApiResponse
        if (message.replyTo) {
          response = await client.im.message.reply({
            path: { message_id: message.replyTo },
            data: { ...payload, uuid },
          })
        } else {
          response = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { ...payload, receive_id: message.address.id.split(':').at(-1)!, uuid },
          })
        }
        const result = receipt(response)
        if (result.status !== 'sent' || !message.files?.length || !message.text.trim()) return result
        // Native file messages cannot contain a caption. Keep it as a reply to the uploaded file.
        try {
          const caption = receipt(
            await client.im.message.reply({
              path: { message_id: result.messageId },
              data: { msg_type: 'interactive', content: larkCard(message), uuid: `${uuid}-caption` },
            })
          )
          return caption.status === 'sent'
            ? result
            : { status: 'unknown', error: `附件已发送，但说明未确认送达。附件消息 ID：${result.messageId}` }
        } catch {
          return { status: 'unknown', error: `附件已发送，但说明未确认送达。附件消息 ID：${result.messageId}` }
        }
      } catch (error) {
        return transportFailure(error)
      }
    },
    async edit(messageId, message) {
      if (!canAccess(message.address)) return { status: 'failed', error: '此会话不在账号的访问列表中。' }
      if (message.files?.length) return { status: 'failed', error: '飞书附件消息不支持编辑。' }
      let card: string
      try {
        card = larkCard(message)
      } catch (error) {
        if (error instanceof LarkCardTooLong) return longReply(message, messageId)
        return { status: 'failed', error: errorMessage(error) }
      }
      try {
        return receipt(
          await client.im.message.patch({ path: { message_id: messageId }, data: { content: card } }),
          messageId
        )
      } catch (error) {
        return transportFailure(error)
      }
    },
    async readHistory(address, before) {
      if (!canAccess(address)) throw new Error('此会话不在账号的访问列表中。')
      const chatId = address.id.split(':').at(-1)!
      let endTime: string | undefined
      let beforeTime = Number.POSITIVE_INFINITY
      if (before) {
        const response = await client.im.message.get({ path: { message_id: before } })
        const item = response.data?.items?.[0]
        if (response.code !== 0 || !item?.create_time) throw new Error('无法确定历史消息的位置。')
        if (item.chat_id !== chatId) throw new Error('历史消息不属于此会话。')
        beforeTime = Number(item.create_time)
        endTime = String(Math.ceil(beforeTime / 1_000))
      }
      const response = await client.im.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          page_size: 50,
          sort_type: 'ByCreateTimeDesc',
          end_time: endTime,
        },
      })
      if (response.code !== 0) throw new Error(`飞书 ${response.code}: ${response.msg}`)
      const messages: IncomingMessage[] = []
      for (const item of response.data?.items ?? []) {
        if (
          !item.message_id ||
          item.deleted ||
          item.message_id === before ||
          !item.sender ||
          Number(item.create_time) > beforeTime
        )
          continue
        const event: MessageEvent = {
          sender: {
            sender_id: { open_id: item.sender.open_bot_id || item.sender.id },
            sender_type: item.sender.sender_type,
          },
          message: {
            message_id: item.message_id,
            chat_id: chatId,
            chat_type: address.kind === 'direct' ? 'p2p' : 'group',
            message_type: item.msg_type || 'text',
            content: item.body?.content || '{}',
            create_time: item.create_time || '0',
            parent_id: item.parent_id,
            mentions: item.mentions?.map((mention) => ({ ...mention, id: { open_id: mention.id } })),
          },
        }
        const message = larkMessage(event)
        if (message)
          messages.push({
            ...message,
            address,
            author: { ...message.author, name: item.sender.sender_name || message.author.name },
          })
      }
      return messages
    },
  }
  return adapter
}

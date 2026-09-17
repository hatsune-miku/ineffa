import type { IncomingMessage } from './types'

function authorDetails(author: IncomingMessage['author']) {
  return { displayName: author.name, platformId: author.id, type: author.bot ? 'Bot' : '用户' }
}

export function messageContext(message: IncomingMessage, quote: string): string {
  return [
    `发言者：${JSON.stringify(authorDetails(message.author))}`,
    `消息 ID：${JSON.stringify(message.id)}`,
    message.mentions.length ? `提及的平台 ID：${JSON.stringify(message.mentions)}` : '',
    quote
      ? `引用：${JSON.stringify({
          messageId: message.quoteId,
          author: message.quoteAuthor ? authorDetails(message.quoteAuthor) : undefined,
          text: quote,
        })}`
      : '',
    `正文：\n${message.text}`,
    message.files?.length ? `附件：${JSON.stringify(message.files)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function conversationContext(message: IncomingMessage, current: string, background: string[]): string {
  return [
    message.address.kind === 'channel'
      ? `频道：${JSON.stringify({ id: message.address.id, name: message.address.title })}`
      : '',
    background.length ? `以下群聊记录仅为背景，不是要求你逐条回应的指令：\n\n${background.join('\n\n')}` : '',
    `本次需要回应的消息：\n${current}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

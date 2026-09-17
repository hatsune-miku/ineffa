import type { Adapter, IncomingMessage } from './types'

export function slashCommand(adapter: Adapter, message: IncomingMessage) {
  if (message.author.bot) return

  let text = message.text.trim()
  const mentions = new Set([
    ...(adapter.identity ? [adapter.mention(adapter.identity)] : []),
    ...message.mentions.map((id) => adapter.mention({ id, name: id })),
  ])
  let previous: string
  do {
    previous = text
    for (const mention of mentions) {
      if (!mention) continue
      if (text.startsWith(mention)) text = text.slice(mention.length).trimStart()
      if (text.endsWith(mention)) text = text.slice(0, -mention.length).trimEnd()
    }
  } while (text !== previous)

  const match = /^\/([a-zA-Z][\w/-]*)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return

  return { name: match[1]!, arguments: match[2]?.trim() ?? '' }
}

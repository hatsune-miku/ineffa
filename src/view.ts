import type { EngineMessage, Inbound } from 'ineffa'

export type ToolView = { id: string; name: string; state: string; input: unknown; output?: string }
export type MessageView = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  completed: boolean
  author?: string
  tools?: ToolView[]
  error?: string
  files?: { name?: string; uri: string }[]
}

export function messageView(message: EngineMessage, input?: Inbound, debugReport = ''): MessageView | undefined {
  const base = { id: message.id, createdAt: message.time.created, completed: true }
  if (message.type === 'user')
    return {
      ...base,
      role: 'user',
      text: input?.message.text ?? message.text,
      author: input
        ? `${input.message.author.name} · ${input.message.author.id}${input.message.author.bot ? ' · Bot' : ''}`
        : undefined,
      files: input?.message.files,
    }
  if (message.type === 'assistant') {
    const tools = message.content.flatMap((part): ToolView[] => {
      if (part.type !== 'tool') return []
      const state = part.state
      return [
        {
          id: part.id,
          name: part.name,
          state: state.status,
          input: 'input' in state ? state.input : undefined,
          output:
            'content' in state
              ? state.content
                  ?.filter((item) => item.type === 'text')
                  .map((item) => item.text)
                  .join('\n')
              : undefined,
        },
      ]
    })
    return {
      ...base,
      role: 'assistant',
      author: message.agent,
      text:
        message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n\n') + debugReport,
      completed: Boolean(message.time.completed),
      tools,
      error: message.error?.message,
    }
  }
  if (message.type === 'compaction')
    return { ...base, role: 'system', text: '上下文已由 OpenCode 整理。原始对话仍保留。' }
  if (message.type === 'synthetic') return { ...base, role: 'system', text: message.text }
  return undefined
}

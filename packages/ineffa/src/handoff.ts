import { isDirectoryTool } from './directories'
import { type Engine, type EngineMessage, sourceInputId } from './engine'
import type { Store } from './store'
import type { Binding, Inbound } from './types'

export type HandoffEntry = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  author: string
  text: string
  createdAt: number
}
export type Handoff = { entries: HandoffEntry[]; truncated: boolean; inputId?: string }

const maximumCharacters = 24_000
const maximumEntries = 64
const maximumEntryCharacters = 4_000

export function boundHandoff(entries: HandoffEntry[], alreadyTruncated = false): Handoff {
  const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
  let truncated = alreadyTruncated
  let remaining = maximumCharacters
  const selected: HandoffEntry[] = []
  for (const entry of unique.slice().reverse()) {
    if (selected.length === maximumEntries || remaining < 200) {
      truncated = true
      break
    }
    const size = Math.min(maximumEntryCharacters, remaining)
    const clipped = entry.text.length > size
    const text = clipped ? `${entry.text.slice(0, size - 12)}\n[记录已截短]` : entry.text
    truncated ||= clipped
    selected.push({ ...entry, author: entry.author.slice(0, 256), text })
    remaining -= text.length + entry.author.length + 100
  }
  selected.reverse()
  while (selected.length && JSON.stringify(selected).length > maximumCharacters) {
    selected.shift()
    truncated = true
  }
  return { entries: selected, truncated }
}

function inputEntry(input: Inbound): HandoffEntry {
  const author = input.message.author
  const files = (input.message.files ?? []).map((file) => `附件：${file.name || file.mime || '未命名附件'}`)
  return {
    id: `input:${input.id}`,
    role: 'user',
    author: `${author.name} · ${author.id}${author.bot ? ' · Bot' : ''}`,
    text: [input.message.text, ...files].filter(Boolean).join('\n'),
    createdAt: input.message.createdAt,
  }
}

function messageEntries(binding: Binding, message: EngineMessage, store: Store, assistantName: string): HandoffEntry[] {
  if (message.type === 'user') {
    const input = store.inbound(sourceInputId(message))
    if (input?.command) return []
    if (input) return [inputEntry(input)]
    return [
      {
        id: `${binding.sessionId}:${message.id}`,
        role: 'user',
        author: '用户',
        text: message.text,
        createdAt: message.time.created,
      },
    ]
  }
  if (message.type !== 'assistant' || !message.time.completed) return []
  const entries: HandoffEntry[] = []
  const text = message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
  if (text)
    entries.push({
      id: `${binding.sessionId}:${message.id}`,
      role: 'assistant',
      author: assistantName,
      text,
      createdAt: message.time.created,
    })
  for (const part of message.content) {
    if (
      part.type !== 'tool' ||
      isDirectoryTool(part.name) ||
      !['completed', 'error', 'failed'].includes(part.state.status)
    )
      continue
    const output = part.state.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n')
    if (output)
      entries.push({
        id: `${binding.sessionId}:${message.id}:${part.id}`,
        role: 'tool',
        author: `${part.name} · ${part.state.status}`,
        text: output,
        createdAt: message.time.created,
      })
  }
  return entries
}

/** Copy visible records as historical data, never native executable tool calls or private reasoning. */
export async function buildHandoff(
  binding: Binding,
  engine: Engine,
  store: Store,
  assistantName = binding.adapterId
): Promise<Handoff> {
  const inherited = store.handoff(binding.id)
  const messages: EngineMessage[] = []
  let cursor: string | undefined
  let truncated = inherited?.truncated ?? false
  for (let page = 0; page < 3; page++) {
    const result = await engine.messages(binding.sessionId, cursor)
    messages.push(...result.data)
    cursor = result.cursor.next ?? undefined
    if (!cursor) break
    if (page === 2) truncated = true
  }
  const current = messages.reverse().flatMap((message) => messageEntries(binding, message, store, assistantName))
  const consumed = store.consumedBackground(binding.id).map(inputEntry)
  const ordered = [...current, ...consumed].sort((left, right) => left.createdAt - right.createdAt)
  return boundHandoff([...(inherited?.entries ?? []), ...ordered], truncated)
}

export function handoffPrompt(handoff: Handoff): string {
  return [
    '以下是切换执行后端前的历史记录，仅供理解当前对话。工具记录中的操作已经执行，不要因交接而重复执行；以用户接下来提出的新请求为准。',
    handoff.truncated ? '历史按长度保留了近期记录，部分内容已截短。完整记录仍在原会话。' : '',
    JSON.stringify(handoff.entries.map(({ role, author, text }) => ({ role, author, text }))),
    '以上历史记录结束。下面是当前新消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

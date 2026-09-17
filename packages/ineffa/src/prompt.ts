import type { Adapter, AgentPrompt } from './types'
import { IneffaError } from './types'

export type AccountPrompt = { system?: string; context: string }

export function validateAgentPrompt(value: unknown): AgentPrompt | undefined {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IneffaError('invalid_agent_prompt', 'Agent 提示词格式不正确。')
  }

  const fields = value as Record<string, unknown>
  const result = { identity: '', task: '' }
  for (const field of ['identity', 'task'] as const) {
    const text = fields[field] ?? ''
    if (typeof text !== 'string' || text.length > 16_000) {
      throw new IneffaError('invalid_agent_prompt', '每项 Agent 提示词须为不超过 16,000 字符的文本。')
    }
    result[field] = text.trim()
  }
  return result.identity || result.task ? result : undefined
}

export function expandPrompt(template: string, adapter: Adapter): string {
  const values = {
    displayName: adapter.name,
    platformId: adapter.identity?.id ?? '',
  }
  // One pass: macro-like text inside a display name is never expanded again.
  return template.replace(/\{(displayName|platformId)\}/g, (_, key: keyof typeof values) => values[key])
}

function accountDetails(adapter: Adapter) {
  return {
    displayName: adapter.name,
    platformId: adapter.identity!.id,
    mention: adapter.mention(adapter.identity!),
  }
}

export function accountPrompt(adapter: Adapter, peers: Adapter[]): AccountPrompt | undefined {
  if (!adapter.identity) return

  const profile = adapter.agentPrompt
  const system = [
    profile?.identity ? `Agent 身份：\n${expandPrompt(profile.identity, adapter)}` : '',
    profile?.task ? `该做什么：\n${expandPrompt(profile.task, adapter)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const context = [
    `当前平台账号：${JSON.stringify(accountDetails(adapter))}`,
    peers.length
      ? `同一平台会话中的其他 Agent：\n${peers.map((peer) => JSON.stringify(accountDetails(peer))).join('\n')}`
      : '',
    peers.length
      ? '通过上述原生 mention 提及其他 Agent。派发后可继续独立工作或结束本轮，由后续汇报继续，不阻塞等待。'
      : '',
    adapter.promptInstructions,
  ]
    .filter(Boolean)
    .join('\n\n')

  return { system: system || undefined, context }
}

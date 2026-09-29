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
      ? [
          '协作规则：只有回复正文中的原生 mention 才会唤醒对方；普通名字、引用和代码块中的 mention 不会。',
          '派发任务时明确交付目标和汇报对象。接手他人委派的工作后，完成、受阻或需要决策时，必须在回复正文中用原生 mention 向进度主导者汇报结果和下一步；未指定汇报对象时，向委托你的 Agent 汇报。',
          '本次协作发信方提供当前消息发送者的准确 mention；它不自动表示任务委派，需结合正文和已有分工判断。不要把初始发起者、当前发信方和明确指定的汇报对象混淆。',
          '派发后可继续独立工作或结束本轮，由后续汇报继续，不阻塞等待。收到汇报后继续整合或推进；仅为确认收到或致谢时，不要再次 mention 对方。',
        ].join('\n')
      : '',
    adapter.promptInstructions,
  ]
    .filter(Boolean)
    .join('\n\n')

  return { system: system || undefined, context }
}

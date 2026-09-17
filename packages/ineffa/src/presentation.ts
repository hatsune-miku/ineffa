import type { OpenCodeEvent } from '@opencode/sdk'

import { Delivery } from './delivery'
import type { OpenCodeBridge } from './opencode'
import { isDirectoryTool } from './tool-directory'
import type { Binding } from './types'

type Turn = {
  sourceId?: string
  bodies: Map<string, string>
  tools: Map<string, string>
  tokens: Map<string, number>
  thinking?: 'in progress' | 'complete' | 'interrupted'
  finished?: boolean
  interrupted?: boolean
}
type JournalEvent = ReturnType<OpenCodeBridge['log']> extends AsyncIterable<infer Event> ? Event : never

export function formatOutputTokens(count: number | undefined): string {
  if (count === undefined) return '— tks'
  const scale = count < 1_000 ? 1 : count < 1_000_000 ? 1_000 : 1_000_000
  const unit = scale === 1 ? 'tks' : scale === 1_000 ? 'k' : 'Mtks'
  const value = (count / scale).toLocaleString('en-US', { maximumFractionDigits: 3 })
  return `${value} ${unit}`
}

/** Platform presentation only. OpenCode retains ownership of execution and conversation history. */
export class Presentation {
  private turns = new Map<string, Turn>()
  private text = new Map<string, { id: string; parts: Map<number, string> }>()
  private completed = new Map<string, string>()

  constructor(private delivery: Delivery) {}

  delta(binding: Binding, event: Extract<OpenCodeEvent, { type: 'session.text.delta' }>) {
    const { assistantMessageID: id, ordinal, delta } = event.data
    if (this.completed.get(binding.id) === id) return
    let draft = this.text.get(binding.id)
    if (draft?.id !== id) this.text.set(binding.id, (draft = { id, parts: new Map() }))
    const parts = draft.parts
    parts.set(ordinal, (parts.get(ordinal) ?? '') + delta)
    const text = [...parts]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('\n\n')
    const turn = this.turns.get(binding.id)
    if (!turn || turn.finished) return
    turn.sourceId ??= id
    turn.bodies.set(id, text)
    if (text.trim()) this.publish(binding, turn, false)
  }

  observe(binding: Binding, event: JournalEvent, replay = false) {
    if (event.type === 'session.execution.started') {
      this.turns.set(binding.id, { bodies: new Map(), tools: new Map(), tokens: new Map() })
      return
    }
    let turn = this.turns.get(binding.id)
    if (!turn) return
    // OpenCode may drain several queued inputs inside one execution.
    if (event.type === 'session.step.started' && turn.finished) {
      turn = { bodies: new Map(), tools: new Map(), tokens: new Map() }
      this.turns.set(binding.id, turn)
    }
    let changed = false
    let complete = false
    switch (event.type) {
      case 'session.step.started':
        turn.sourceId ??= event.data.assistantMessageID
        break
      case 'session.reasoning.started':
        turn.thinking = 'in progress'
        changed = true
        break
      case 'session.reasoning.ended':
        turn.thinking = 'complete'
        changed = true
        break
      case 'session.tool.input.started':
        if (isDirectoryTool(event.data.name)) break
        turn.tools.set(event.data.id, event.data.name)
        changed = true
        break
      case 'session.step.ended':
      case 'session.step.failed': {
        const tokens = event.data.tokens
        // OpenCode output counts visible tokens; reasoning is reported separately.
        if (tokens) turn.tokens.set(event.data.assistantMessageID, tokens.output + tokens.reasoning)
        if (this.text.get(binding.id)?.id === event.data.assistantMessageID) this.text.delete(binding.id)
        this.completed.set(binding.id, event.data.assistantMessageID)
        break
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        turn.interrupted = event.type !== 'session.execution.succeeded'
        if (turn.thinking) turn.thinking = event.type === 'session.execution.succeeded' ? 'complete' : 'interrupted'
        complete = true
        changed = true
        break
    }
    if (changed && !replay && !turn.finished) this.publish(binding, turn, complete)
    if (complete) this.turns.delete(binding.id)
  }

  sourceId(binding: Binding, fallback: string) {
    return this.turns.get(binding.id)?.sourceId ?? fallback
  }

  step(binding: Binding, messageId: string, text: string, complete: boolean, replay = false, failed = false) {
    const turn = this.turns.get(binding.id)
    if (!turn || turn.finished) return
    turn.sourceId ??= messageId
    turn.bodies.set(messageId, text)
    turn.interrupted = failed
    if (!replay) this.publish(binding, turn, complete)
    turn.finished = complete
  }

  private publish(binding: Binding, turn: Turn, complete: boolean) {
    if (!turn.sourceId) return
    const tokens = formatOutputTokens(
      turn.tokens.size ? [...turn.tokens.values()].reduce((sum, count) => sum + count, 0) : undefined
    )
    const counts = new Map<string, number>()
    for (const name of turn.tools.values()) counts.set(name, (counts.get(name) ?? 0) + 1)
    const tools = [...counts].map(([name, count]) => `${name} x${count}`).join(', ')
    const notes = [
      [tokens, tools, turn.thinking ? `Think ${turn.thinking}` : '', turn.interrupted ? '已停止' : '']
        .filter(Boolean)
        .join(' · '),
    ]
    const text = [...turn.bodies.values()].filter((body) => body.trim()).join('\n\n')
    if (!complete && !text && !turn.tools.size && !turn.thinking) return
    this.delivery.publish(
      binding,
      turn.sourceId,
      turn.interrupted ? null : binding.inputId,
      text,
      'reply',
      complete,
      notes
    )
  }

  interrupt(binding: Binding) {
    const turn = this.turns.get(binding.id)
    if (!turn) return
    if (turn.finished) return
    turn.interrupted = true
    if (turn.thinking) turn.thinking = 'interrupted'
    this.publish(binding, turn, true)
    this.turns.delete(binding.id)
  }

  clear(binding: Binding) {
    this.turns.delete(binding.id)
    this.text.delete(binding.id)
    this.completed.delete(binding.id)
    this.delivery.discard(binding)
  }
}

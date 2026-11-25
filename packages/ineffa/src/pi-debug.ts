import type { EngineDebug, EngineEvent } from './engine'

type Trace = {
  started: number
  tools: Map<string, { started: number; ended?: number }>
  input: number
  cache: number
}

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`
}

/** Pi phase one reports only measurements available from its public session events. */
export class PiDebug implements EngineDebug {
  enabled = (_sessionId: string) => false
  private traces = new Map<string, Trace>()
  private messages = new Map<string, { sessionId: string; trace: Trace }>()
  private reporting = new Map<string, Trace>()

  start(sessionId: string) {
    if (!this.enabled(sessionId)) return
    this.traces.set(sessionId, { started: Date.now(), tools: new Map(), input: 0, cache: 0 })
  }

  step(sessionId: string, messageId: string) {
    const trace = this.traces.get(sessionId)
    if (trace) this.messages.set(messageId, { sessionId, trace })
  }

  tool(sessionId: string, id: string, completed: boolean) {
    const trace = this.traces.get(sessionId)
    if (!trace) return
    if (!completed) trace.tools.set(id, { started: Date.now() })
    else {
      const tool = trace.tools.get(id)
      if (tool) tool.ended = Date.now()
    }
  }

  usage(event: Extract<EngineEvent, { type: 'session.step.ended' | 'session.step.failed' }>) {
    const trace = this.messages.get(event.data.assistantMessageID)?.trace
    const tokens = event.data.tokens
    if (!trace) return
    this.reporting.set(event.data.sessionID, trace)
    if (!tokens) return
    trace.input += tokens.input + tokens.cache.read + tokens.cache.write
    trace.cache += tokens.cache.read
  }

  report(sessionId: string, endedAt: number) {
    const trace = this.reporting.get(sessionId) ?? this.traces.get(sessionId)
    if (!trace) return ''
    const elapsed = [...trace.tools.values()].reduce((sum, tool) => sum + (tool.ended ?? endedAt) - tool.started, 0)
    const fields = [`总计 ${duration(endedAt - trace.started)}`, `工具 ${trace.tools.size} 次 / ${duration(elapsed)}`]
    if (trace.input > 0 && trace.cache > 0) fields.push(`缓存命中 ${((trace.cache / trace.input) * 100).toFixed(1)}%`)
    return `\n\n> Debug · ${fields.join(' · ')}`
  }

  clear(sessionId: string) {
    this.traces.delete(sessionId)
    this.reporting.delete(sessionId)
    for (const [id, message] of this.messages) if (message.sessionId === sessionId) this.messages.delete(id)
  }

  finish(sessionId: string, _endedAt: number) {
    const trace = this.reporting.get(sessionId)
    if (!trace) return
    this.reporting.delete(sessionId)
    if (this.traces.get(sessionId) === trace) this.traces.delete(sessionId)
    for (const [id, message] of this.messages) if (message.trace === trace) this.messages.delete(id)
  }
}

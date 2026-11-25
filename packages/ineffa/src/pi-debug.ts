import type { FetchFunction } from '@earendil-works/pi-ai'

import { debugDuration } from './debug'
import { observeFirstSse } from './debug-stream'
import type { EngineDebug, EngineEvent } from './engine'

type RequestTiming = {
  startedAt: number
  started: number
  headersMs?: number
  firstSseMs?: number
  status?: number
}
type ToolTiming = { startedAt: number; started: number; ended?: number }
type Usage = { endedAt: number; input: number; cache: number }
type Trace = {
  startedAt: number
  requests: RequestTiming[]
  tools: Map<string, ToolTiming>
  usage: Map<string, Usage>
}

function milliseconds(value: number | undefined) {
  return value === undefined ? '未采集' : `${Math.max(0, value).toFixed(0)} ms`
}

function headerStatistics(requests: RequestTiming[]) {
  const values = requests.flatMap((request) => (request.headersMs === undefined ? [] : [request.headersMs]))
  if (!values.length) return '未采集'
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return `最小 ${milliseconds(minimum)} / 最大 ${milliseconds(maximum)} / 平均 ${milliseconds(average)}`
}

/** Measurements stay attached to a turn while queued turns and journal consumers advance independently. */
export class PiDebug implements EngineDebug {
  enabled = (_sessionId: string) => false
  private traces = new Map<string, Trace>()
  private messages = new Map<string, { sessionId: string; trace: Trace }>()
  private reporting = new Map<string, Trace>()
  private suspended = new Set<string>()

  start(sessionId: string) {
    if (!this.enabled(sessionId)) return
    this.traces.set(sessionId, {
      startedAt: Date.now(),
      requests: [],
      tools: new Map(),
      usage: new Map(),
    })
  }

  suspend(sessionId: string, suspended: boolean) {
    if (suspended) this.suspended.add(sessionId)
    else this.suspended.delete(sessionId)
  }

  /** The SDK passes this fetch only to the selected session's provider requests. */
  wrapFetch(sessionId: string, transport: FetchFunction = globalThis.fetch): FetchFunction {
    const debug = this
    async function observed(...args: Parameters<FetchFunction>): Promise<Response> {
      const trace = debug.traces.get(sessionId)
      if (!trace || !debug.enabled(sessionId) || debug.suspended.has(sessionId)) return transport(...args)
      const timing: RequestTiming = { startedAt: Date.now(), started: performance.now() }
      trace.requests.push(timing)
      const response = await transport(...args)
      timing.headersMs = performance.now() - timing.started
      timing.status = response.status
      return observeFirstSse(response, () => {
        timing.firstSseMs = performance.now() - timing.started
      })
    }
    return Object.assign(observed, transport)
  }

  step(sessionId: string, messageId: string) {
    const trace = this.traces.get(sessionId)
    if (trace) this.messages.set(messageId, { sessionId, trace })
  }

  tool(sessionId: string, id: string, completed: boolean) {
    const trace = this.traces.get(sessionId)
    if (!trace) return
    if (!completed) trace.tools.set(id, { startedAt: Date.now(), started: performance.now() })
    else {
      const tool = trace.tools.get(id)
      if (tool) tool.ended = performance.now()
    }
  }

  usage(event: Extract<EngineEvent, { type: 'session.step.ended' | 'session.step.failed' }>) {
    const trace = this.messages.get(event.data.assistantMessageID)?.trace
    const tokens = event.data.tokens
    if (!trace) return
    this.reporting.set(event.data.sessionID, trace)
    if (!tokens) return
    // Pi normalizes input to uncached tokens, excluding both cache reads and writes.
    trace.usage.set(event.data.assistantMessageID, {
      endedAt: event.created,
      input: tokens.input + tokens.cache.read + tokens.cache.write,
      cache: tokens.cache.read,
    })
  }

  report(sessionId: string, endedAt: number) {
    const trace = this.reporting.get(sessionId) ?? this.traces.get(sessionId)
    if (!trace) return ''
    const requests = trace.requests.filter((request) => request.startedAt <= endedAt)
    const first = requests.find((request) => request.firstSseMs !== undefined)
    const firstMs = first ? first.started - requests[0]!.started + first.firstSseMs! : undefined
    const tools = [...trace.tools.values()].filter((tool) => tool.startedAt <= endedAt)
    const completed = tools.filter((tool) => tool.ended !== undefined)
    const toolMs = completed.reduce((sum, tool) => sum + tool.ended! - tool.started, 0)
    const usage = [...trace.usage.values()].filter((item) => item.endedAt <= endedAt)
    const input = usage.reduce((sum, item) => sum + item.input, 0)
    const cache = usage.reduce((sum, item) => sum + item.cache, 0)
    const fields = [
      `连接/响应头 ${headerStatistics(requests)}`,
      `首字 ${milliseconds(firstMs)}`,
      `服务排队 ${firstMs === undefined ? '未采集' : debugDuration(firstMs)}`,
      `总计 ${debugDuration(endedAt - trace.startedAt)}`,
      `缓存命中 ${input > 0 && cache > 0 ? `${((cache / input) * 100).toFixed(1)}%` : '—'}`,
      `工具 ${tools.length} 次 / ${debugDuration(toolMs)}${completed.length < tools.length ? '（未全部结束）' : ''}`,
    ]
    const errors = [
      ...new Set(
        requests.flatMap((request) => (request.status && request.status >= 400 ? [`HTTP ${request.status}`] : []))
      ),
    ]
    if (errors.length) fields.push(errors.join(', '))
    return `\n\n> Debug · ${fields.join(' · ')}`
  }

  clear(sessionId: string) {
    this.traces.delete(sessionId)
    this.reporting.delete(sessionId)
    this.suspended.delete(sessionId)
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

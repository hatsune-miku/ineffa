import { Plugin } from '@opencode/plugin'
import type { OpenCode, OpenCodeEvent } from '@opencode/sdk'

import { observeFirstSse } from './debug-stream'
import { isDirectoryTool } from './tool-directory'

type RequestTiming = {
  startedAt: number
  started: number
  model: string
  headersMs?: number
  status?: number
  firstSseMs?: number
}
type ToolTiming = { name: string; startedAt: number; started: number; ended?: number; status?: string }
type CacheUsage = { endedAt: number; input: number; read: number }
type Trace = {
  startedAt: number
  requests: RequestTiming[]
  tools: Map<string, ToolTiming>
  usage: Map<string, CacheUsage>
}

function milliseconds(value: number | undefined) {
  return value === undefined ? '未采集' : `${Math.max(0, value).toFixed(0)} ms`
}

export function debugDuration(value: number): string {
  const seconds = Math.floor(Math.max(0, value) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [hours ? `${hours}h` : '', hours || minutes ? `${minutes}m` : '', `${seconds % 60}s`].filter(Boolean).join(' ')
}

function headerStatistics(requests: RequestTiming[]): string {
  const values = requests.flatMap((item) => (item.headersMs === undefined ? [] : [item.headersMs]))
  if (!values.length) return '未采集'

  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return `最小 ${milliseconds(minimum)} / 最大 ${milliseconds(maximum)} / 平均 ${milliseconds(average)}`
}

/** Debug-only HTTP/stream observations; no extra model calls or changes to tool execution. */
export class DebugTimings {
  enabled: (sessionId: string) => boolean = () => false
  private traces = new Map<string, Trace>()
  private requests = new WeakMap<Request, RequestTiming>()

  private trace(sessionId: string): Trace | undefined {
    if (!this.enabled(sessionId)) return
    let trace = this.traces.get(sessionId)
    if (!trace) {
      trace = { startedAt: Date.now(), requests: [], tools: new Map(), usage: new Map() }
      this.traces.set(sessionId, trace)
    }
    return trace
  }

  plugin = Plugin.define({
    id: 'ineffa.debug-timings',
    setup: async (context) => {
      await context.session.hook('http.request', (event) => {
        if (event.kind !== 'primary') return
        const trace = this.trace(event.sessionID)
        if (!trace) return
        const timing: RequestTiming = {
          startedAt: Date.now(),
          started: performance.now(),
          model: `${event.model.providerID}/${event.model.id}`,
        }
        trace.requests.push(timing)
        this.requests.set(event.request, timing)
      })
      await context.session.hook('http.response', (event) => {
        const timing = this.requests.get(event.request)
        if (!timing) return
        timing.headersMs = performance.now() - timing.started
        timing.status = event.response.status
        event.response = observeFirstSse(event.response, () => {
          timing.firstSseMs = performance.now() - timing.started
        })
      })
      await context.tool.hook('execute.before', (event) => {
        if (isDirectoryTool(event.tool)) return
        this.trace(event.sessionID)?.tools.set(event.id, {
          name: event.tool,
          startedAt: Date.now(),
          started: performance.now(),
        })
      })
      await context.tool.hook('execute.after', (event) => {
        if (isDirectoryTool(event.tool)) return
        const tool = this.traces.get(event.sessionID)?.tools.get(event.id)
        if (!tool) return
        tool.ended = performance.now()
        tool.status = event.status === 'completed' ? '完成' : '失败'
      })
    },
  })

  instances(original?: OpenCode.CreateOptions['instances']): NonNullable<OpenCode.CreateOptions['instances']> {
    return {
      key: (session) => JSON.stringify([original?.key(session) ?? '', this.enabled(session.id)]),
      configure: async (key) => {
        const [base, debug] = JSON.parse(key) as [string, boolean]
        const configured = original ? await original.configure(base) : { plugins: [] }
        return { plugins: [...configured.plugins, ...(debug ? [this.plugin] : [])] }
      },
    }
  }

  usage(event: Extract<OpenCodeEvent, { type: 'session.step.ended' | 'session.step.failed' }>) {
    const trace = this.traces.get(event.data.sessionID)
    const tokens = event.data.tokens
    if (!trace || !tokens) return
    trace.usage.set(event.data.assistantMessageID, {
      endedAt: event.created,
      // OpenCode input excludes both cache reads and writes.
      input: tokens.input + tokens.cache.read + tokens.cache.write,
      read: tokens.cache.read,
    })
  }

  report(sessionId: string, endedAt: number): string {
    const trace = this.traces.get(sessionId)
    const requests = trace?.requests.filter((item) => item.startedAt <= endedAt) ?? []
    const tools = [...(trace?.tools.values() ?? [])].filter((item) => item.startedAt <= endedAt)
    const completed = tools.filter((item) => item.ended !== undefined)
    const totalTools = completed.reduce((sum, item) => sum + item.ended! - item.started, 0)
    const firstSse = requests.find((item) => item.firstSseMs !== undefined)
    const firstMs = firstSse ? firstSse.started - requests[0]!.started + firstSse.firstSseMs! : undefined
    if (!trace) return '\n\n> Debug · 未采集'
    const headers = headerStatistics(requests)
    const errors = requests.filter((item) => item.status && item.status >= 400).map((item) => `HTTP ${item.status}`)
    const usage = [...trace.usage.values()].filter((item) => item.endedAt <= endedAt)
    const input = usage.reduce((sum, item) => sum + item.input, 0)
    const read = usage.reduce((sum, item) => sum + item.read, 0)
    // The SDK normalizes absent cache counts to zero; do not present that as a confirmed miss.
    const cache = input > 0 && read > 0 ? `${((read / input) * 100).toFixed(1)}%` : '—'
    const fields = [
      `连接/响应头 ${headers}`,
      `首字 ${milliseconds(firstMs)}`,
      `服务排队 ${firstMs === undefined ? '未采集' : debugDuration(firstMs)}`,
      `总计 ${debugDuration(endedAt - trace.startedAt)}`,
      `缓存命中 ${cache}`,
      `工具 ${tools.length} 次 / ${debugDuration(totalTools)}${completed.length < tools.length ? '（未全部结束）' : ''}`,
    ]
    if (errors.length) fields.push(errors.join(', '))
    return `\n\n> Debug · ${fields.join(' · ')}`
  }

  clear(sessionId: string) {
    this.traces.delete(sessionId)
  }
  finish(sessionId: string, endedAt: number) {
    const trace = this.traces.get(sessionId)
    if (!trace) return
    trace.requests = trace.requests.filter((item) => item.startedAt > endedAt)
    trace.tools = new Map([...trace.tools].filter(([, item]) => item.startedAt > endedAt))
    trace.usage = new Map([...trace.usage].filter(([, item]) => item.endedAt > endedAt))
    const starts = [
      ...trace.requests.map((item) => item.startedAt),
      ...[...trace.tools.values()].map((item) => item.startedAt),
    ]
    if (starts.length) trace.startedAt = Math.min(...starts)
    else this.clear(sessionId)
  }
}

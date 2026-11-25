import type { AccountPrompt } from './prompt'
import type { Attachment, Binding, Inbound } from './types'

export type Backend = 'opencode' | 'pi'
export type ModelReference = { providerID: string; id: string }
export type EngineTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
export type PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
export type EngineSession = {
  id: string
  agent?: string
  model?: ModelReference
  tokens: EngineTokens
  cost: number
  outcome?: string
  permissions?: PermissionRule[]
}
type MessageBase = { id: string; time: { created: number; completed?: number }; metadata?: Record<string, unknown> }
export type EngineMessage = MessageBase &
  (
    | { type: 'user'; text: string }
    | { type: 'synthetic'; text: string }
    | { type: 'compaction' | 'internal' }
    | {
        type: 'assistant'
        agent: string
        error?: { message: string }
        content: (
          | { type: 'text'; text: string }
          | { type: 'reasoning'; text: string }
          | {
              type: 'tool'
              id: string
              name: string
              state: {
                status: string
                input?: unknown
                content?: { type: string; text?: string }[]
              }
            }
        )[]
      }
  )
type FormOption = { value: string; label: string; description?: string }
type FormFieldBase = {
  key: string
  title?: string
  description?: string
  required?: boolean
  when?: { key: string; op: 'eq' | 'neq'; value: string | number | boolean }[]
}
export type EngineFormField = FormFieldBase &
  (
    | { type: 'external'; url: string }
    | { type: 'boolean'; default?: boolean; minimum?: never; maximum?: never }
    | {
        type: 'number' | 'integer'
        default?: number | 'Infinity' | '-Infinity' | 'NaN'
        minimum?: number | 'Infinity' | '-Infinity' | 'NaN'
        maximum?: number | 'Infinity' | '-Infinity' | 'NaN'
      }
    | { type: 'multiselect'; options: FormOption[]; default?: string[] }
    | {
        type: 'string'
        default?: string
        options?: FormOption[]
        custom?: boolean
        placeholder?: string
        minLength?: number
        maxLength?: number
        pattern?: string
      }
  )
export type EngineForm = {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: EngineFormField[]
}
export type FormAnswer = Record<string, string | number | boolean | string[]>
export type EnginePending = { id: string; delivery: string; type: string; payload: { text?: string } }
type SessionData = { sessionID: string }
type StepData = SessionData & { assistantMessageID: string }
type EventPayload =
  | {
      type:
        | 'session.execution.started'
        | 'session.execution.succeeded'
        | 'session.execution.failed'
        | 'session.execution.interrupted'
      data: SessionData
    }
  | { type: 'session.step.started' | 'session.reasoning.started' | 'session.reasoning.ended'; data: StepData }
  | { type: 'session.step.ended' | 'session.step.failed'; data: StepData & { tokens?: EngineTokens; finish?: string } }
  | { type: 'session.tool.input.started'; data: SessionData & { id: string; name: string } }
  | { type: 'session.inbox.delivered'; data: SessionData & { inboxID: string } }
  | { type: 'session.text.delta'; data: StepData & { ordinal: number; delta: string } }
  | { type: 'form.created'; data: { form: EngineForm } }
  | { type: 'form.replied' | 'form.cancelled'; data: { id: string } }
  | { type: 'permission.asked'; data: SessionData & { id: string; action: string } }
  | { type: 'session.status' | 'server.connected'; data: unknown }
export type EngineEvent = EventPayload & { created: number; durable?: { seq: number } }
export type EngineDebug = {
  enabled: (sessionId: string) => boolean
  usage(event: Extract<EngineEvent, { type: 'session.step.ended' | 'session.step.failed' }>): void
  report(sessionId: string, endedAt: number): string
  clear(sessionId: string): void
  finish(sessionId: string, endedAt: number): void
}

/** Runtime boundary only. Each backend owns its native transcript and tool execution. */
export interface Engine {
  readonly backend: Backend
  readonly debug: EngineDebug
  readonly capabilities: { permissions: boolean; agents: boolean; compact: boolean; steer: boolean }
  configureFileTool(
    available: (sessionId: string) => boolean,
    send: (sessionId: string, messageId: string, callId: string, path: string, caption: string) => Promise<string>
  ): Promise<void>
  configureAccountPrompts(resolvePrompt: (sessionId: string) => AccountPrompt | undefined): Promise<void>
  ready(directory: string): Promise<unknown>
  ensure(binding: Binding, model?: string): Promise<EngineSession>
  getSession(sessionId: string): Promise<EngineSession>
  switchModel(sessionId: string, model: ModelReference): Promise<unknown>
  renameSession(sessionId: string, title: string): Promise<unknown>
  removeSession(sessionId: string): Promise<unknown>
  exportSession(sessionId: string): Promise<unknown>
  compactSession(sessionId: string): Promise<unknown>
  active(): Promise<Record<string, unknown>>
  submit(binding: Binding, input: Inbound, files?: Attachment[]): Promise<unknown>
  log(binding: Binding, signal: AbortSignal): AsyncIterable<EngineEvent>
  events(signal: AbortSignal): AsyncIterable<EngineEvent>
  message(sessionId: string, messageId: string): Promise<EngineMessage>
  messages(sessionId: string, cursor?: string): Promise<{ data: EngineMessage[]; cursor: { next?: string | null } }>
  inputForAssistant(sessionId: string, messageId: string): Promise<string | undefined>
  pending(sessionId: string): Promise<EnginePending[]>
  cancelPending(sessionId: string, inputId: string): Promise<unknown>
  steerPending(sessionId: string, inputId: string): Promise<unknown>
  stop(sessionId: string, cancelQueued?: boolean): Promise<void>
  listForms(sessionId: string): Promise<EngineForm[]>
  getFormState(sessionId: string, formId: string): Promise<{ status: string } | undefined>
  replyForm(sessionId: string, formId: string, answer: FormAnswer): Promise<unknown>
  cancelForm(sessionId: string, formId: string): Promise<unknown>
  close(): Promise<void>
}

export function sourceInputId(message: { id: string; metadata?: Record<string, unknown> }): string {
  const source = message.metadata?.ineffa
  return source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    'inputId' in source &&
    typeof source.inputId === 'string'
    ? source.inputId
    : message.id
}

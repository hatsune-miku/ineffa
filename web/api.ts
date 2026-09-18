import type { AgentPrompt, Binding } from 'ineffa'

import type { OpenCode } from '@opencode/sdk'

import type { ProviderView } from '../src/providers'
import type { MessageView } from '../src/view'

export type { ProviderView } from '../src/providers'

export type Conversation = Binding & { running: boolean; platform: string }
export type Permission = Awaited<ReturnType<OpenCode.Interface['permission']['list']>>[number]
export type PendingForm = Awaited<ReturnType<OpenCode.Interface['form']['get']>>
export type FormField = PendingForm['fields'][number]
export type ConversationDetail = {
  binding: Binding
  accountModel?: string
  messages: MessageView[]
  cursor?: string
  running: boolean
  info: {
    agent?: string
    model?: { providerID: string; id: string }
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    cost: number
    outcome?: string
    permissions: { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }[]
  }
  pending: { id: string; delivery: string; type: string; text: string }[]
  permissions: Permission[]
  forms: PendingForm[]
}
export type Catalog = {
  providers: ProviderView[]
  agents: { id: string; name?: string; description?: string }[]
  models: { id: string; name: string; provider: string }[]
  integrations: {
    id: string
    name: string
    key: boolean
    connected: boolean
    removable: boolean
    environment: string[]
  }[]
}
export type Account = {
  id: string
  name: string
  platform: string
  agent: string
  model?: string
  directory: string
  editable?: boolean
  access?: { guilds?: string[]; channels?: string[]; users?: string[] }
  identity?: { id: string; name: string }
  agentPrompt?: AgentPrompt
  status: { state: string; error?: string }
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message)
  }
}
export async function api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal,
  })
  const value = await response.json()
  if (!response.ok)
    throw new ApiError(
      value.error?.code ?? 'http_error',
      value.error?.message ?? `请求失败，HTTP ${response.status}`,
      response.status
    )
  return value as T
}

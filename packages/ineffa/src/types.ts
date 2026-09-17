export type DeliveryMode = 'queue' | 'steer'
export type Address = { id: string; title: string; kind: 'channel' | 'direct'; guildId?: string }
export type Attachment = { uri: string; name?: string; mime?: string }
export type IncomingMessage = {
  id: string
  address: Address
  author: { id: string; name: string; bot: boolean }
  text: string
  mentions: string[]
  createdAt: number
  quote?: string
  quoteId?: string
  quoteAuthor?: { id: string; name: string; bot: boolean }
  files?: Attachment[]
  mode?: DeliveryMode
}
export type SendResult =
  { status: 'sent'; messageId: string } | { status: 'failed' | 'unknown'; error: string; retryAfterMs?: number }
export type OutputKind = 'reply' | 'tools' | 'thinking' | 'notice'
export type OutgoingMessage = {
  id: string
  address: Address
  text: string
  replyTo?: string
  partial?: boolean
  kind?: OutputKind
}
export type AdapterStatus = { state: 'connecting' | 'connected' | 'disconnected' | 'error'; error?: string }
/** The account's own identity and role, independent of the Ineffa runtime and messaging platform. */
export type AgentPrompt = { identity: string; task: string }
export type AccountProfile = { name?: string; agentPrompt?: AgentPrompt; model?: string }
export type AdapterContext = {
  receive: (message: IncomingMessage) => Promise<void>
  status: (status: AdapterStatus) => void
  echo: (nonce: string, messageId: string) => void
}
export interface Adapter {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly agent: string
  readonly directory: string
  readonly native?: unknown
  readonly identity: { id: string; name: string } | undefined
  readonly agentPrompt?: AgentPrompt
  readonly model?: string
  readonly capabilities: { edit: boolean; attachments: boolean; history: boolean }
  start(context: AdapterContext): Promise<void>
  stop(): Promise<void>
  canAccess(address: Address): boolean
  /** Same key means a shared platform conversation. Omit for private or unknown scopes. */
  conversationKey?(address: Address): string | undefined
  updateProfile?(profile: AccountProfile): void
  send(message: OutgoingMessage): Promise<SendResult>
  edit?(messageId: string, message: OutgoingMessage): Promise<SendResult>
  readHistory?(address: Address, before?: string): Promise<IncomingMessage[]>
  mentions(text: string): string[]
  mention(identity: { id: string; name: string }): string
}
export type Binding = {
  id: string
  adapterId: string
  address: Address
  agent: string
  directory: string
  sessionId: string
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  cursor: number
  inputId: string | null
  engineReady: number
  debug: boolean
}
export type Inbound = {
  id: string
  bindingId: string
  message: IncomingMessage
  prompt: string
  command?: { name: string; arguments: string; previousSessionId?: string }
  rootId: string
  state: 'pending' | 'admitted' | 'failed' | 'cancelled' | 'unknown' | 'observed'
  error: string | null
  createdAt: number
}
export type Outbound = {
  kind: OutputKind
  complete: boolean
  revision: number
  deliveredRevision: number
  sendingRevision: number
  id: string
  bindingId: string
  sourceId: string
  inputId: string | null
  text: string
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'
  messageId: string | null
  error: string | null
  attempts: number
  relayed: boolean
  createdAt: number
}
export type HostEvent =
  | { type: 'change'; bindingId?: string }
  | { type: 'delta'; bindingId: string; messageId: string; ordinal: number; text: string }
  | { type: 'error'; bindingId?: string; message: string }
export class IneffaError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message)
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

import { Store, identity } from './store'
import type { Adapter, Binding, HostEvent, Outbound, OutputKind } from './types'
import { errorMessage } from './types'

/** This serializes platform writes, never model execution. */
export class Delivery {
  private lanes = new Map<string, Promise<void>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private drafts = new Map<string, { bindingId: string; save: () => void }>()
  private lastWrite = new Map<string, number>()
  constructor(
    private store: Store,
    private adapter: (id: string) => Adapter,
    private relay: (output: Outbound, binding: Binding) => Promise<void>,
    private emit: (event: HostEvent) => void
  ) {}
  publish(
    binding: Binding,
    sourceId: string,
    inputId: string | null,
    text: string,
    kind: OutputKind = 'reply',
    complete = false
  ) {
    const adapter = this.adapter(binding.adapterId)
    if (!complete && (!adapter.capabilities.edit || !adapter.edit)) return
    const id = identity('out_', binding.id, sourceId)
    if (this.store.output(id)?.complete) return
    const save = () => {
      if (!this.store.bySession(binding.sessionId)) return
      this.store.prepareOutput(binding.id, sourceId, inputId, text, { kind, complete })
      this.emit({ type: 'change', bindingId: binding.id })
    }
    if (complete) {
      this.drafts.delete(id)
      save() // Commit the final reply before the caller advances the durable event cursor.
    } else {
      this.drafts.set(id, { bindingId: binding.id, save })
    }
    if (!this.timers.has(id))
      this.timers.set(
        id,
        setTimeout(() => this.drain(id), 500)
      )
  }
  private drain(id: string) {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.drafts.get(id)?.save()
    this.drafts.delete(id)
    void this.enqueue(id)
  }
  discard(binding: Binding) {
    for (const [id, draft] of this.drafts) {
      if (draft.bindingId !== binding.id) continue
      clearTimeout(this.timers.get(id))
      this.timers.delete(id)
      this.drafts.delete(id)
      this.lastWrite.delete(id)
    }
    for (const [id, timer] of this.timers) {
      const output = this.store.output(id)
      if (output?.bindingId !== binding.id || output.complete) continue
      clearTimeout(timer)
      this.timers.delete(id)
      this.lastWrite.delete(id)
    }
  }
  enqueue(id: string): Promise<void> {
    const output = this.store.output(id)
    if (!output) return Promise.resolve()
    const key = this.store.binding(output.bindingId).adapterId
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.deliver(id))
      .catch((error) => {
        this.store.relayError(id, errorMessage(error))
        this.emit({ type: 'error', bindingId: output.bindingId, message: errorMessage(error) })
        this.emit({ type: 'change', bindingId: output.bindingId })
      })
    this.lanes.set(key, next)
    void next.finally(() => {
      if (this.lanes.get(key) === next) this.lanes.delete(key)
    })
    return next
  }
  async flush() {
    for (const id of this.timers.keys()) this.drain(id)
    while (this.lanes.size) await Promise.all([...this.lanes.values()])
  }
  private async deliver(id: string) {
    let output = this.store.output(id)
    if (!output) return
    const binding = this.store.binding(output.bindingId)
    let adapter: Adapter
    try {
      adapter = this.adapter(binding.adapterId)
    } catch (error) {
      if (output.state === 'pending') this.store.outputState(id, 'failed', errorMessage(error))
      this.emit({ type: 'change', bindingId: binding.id })
      return
    }
    if (output.state === 'pending') {
      if (binding.archivedAt && !output.complete) return
      if (!adapter.canAccess(binding.address)) {
        this.store.outputState(id, 'failed', '当前账号不再允许访问此会话。')
        this.emit({ type: 'change', bindingId: binding.id })
        return
      }
      this.store.outputState(id, 'sending')
      try {
        const wait = 500 - (Date.now() - (this.lastWrite.get(id) ?? 0))
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        if (!this.store.output(id)) return
        const message = {
          id,
          address: binding.address,
          text: output.text + (output.complete ? this.store.debugReport(output.sourceId) : ''),
          replyTo: output.inputId ? this.store.inbound(output.inputId)?.message.id : undefined,
          partial: !output.complete,
          kind: output.kind,
          files: output.files,
        }
        this.lastWrite.set(id, Date.now())
        const result =
          output.messageId && adapter.edit ? await adapter.edit(output.messageId, message) : await adapter.send(message)
        // An authenticated gateway echo can have confirmed the send before the HTTP response.
        const latest = this.store.output(id)
        if (!latest) return
        if (result.status === 'sent') this.store.outputState(id, 'sent', null, result.messageId, output.revision)
        else if (latest.deliveredRevision < output.revision) this.store.outputState(id, result.status, result.error)
      } catch (error) {
        if ((this.store.output(id)?.deliveredRevision ?? -1) < output.revision)
          this.store.outputState(id, 'unknown', errorMessage(error))
      }
      this.emit({ type: 'change', bindingId: binding.id })
      output = this.store.output(id)
    }
    if (!output) return
    if (output.state === 'pending') void this.enqueue(id)
    if (output.state === 'sent' && output.complete && output.deliveredRevision >= output.revision && !output.relayed) {
      if (output.kind === 'reply' || output.kind === 'attachment') await this.relay(output, binding)
      this.store.relayed(id)
      this.lastWrite.delete(id)
    }
  }
  confirm(adapterId: string, nonce: string, messageId: string) {
    const output = this.store.output(nonce)
    if (!output || output.messageId || this.store.binding(output.bindingId).adapterId !== adapterId) return
    this.store.outputState(output.id, 'sent', null, messageId)
    void this.enqueue(output.id)
  }
}

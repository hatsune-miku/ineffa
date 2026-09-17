import type { OpenCodeBridge } from './opencode'
import { Store, identity } from './store'
import type { Adapter, Binding, IncomingMessage } from './types'

type Form = Awaited<ReturnType<OpenCodeBridge['native']['form']['get']>>
type Answer = Record<string, string | string[]>
type Question = {
  id: string
  bindingId: string
  inputId: string | null
  targetId: string
  form: Form
  answer: Answer
  state: 'pending' | 'submitting' | 'closed'
  createdAt: number
}

/** The engine owns forms. These rows only track their platform recipient and delivery receipts. */
export class Questions {
  private lanes = new Map<string, Promise<unknown>>()

  constructor(
    private store: Store,
    private engine: OpenCodeBridge,
    private adapter: (id: string) => Adapter,
    private enqueue: (id: string) => Promise<void>
  ) {}

  private get(id: string): Question | undefined {
    const row = this.store.db.query('SELECT * FROM platform_questions WHERE id=?').get(id) as
      (Omit<Question, 'form' | 'answer'> & { form: string; answer: string }) | null
    return row ? { ...row, form: JSON.parse(row.form), answer: JSON.parse(row.answer) } : undefined
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    this.lanes.set(key, next)
    void next
      .finally(() => {
        if (this.lanes.get(key) === next) this.lanes.delete(key)
      })
      .catch(() => {})
    return next
  }

  async flush() {
    while (this.lanes.size) await Promise.allSettled([...this.lanes.values()])
  }

  async recover(binding: Binding) {
    if (binding.archivedAt) return
    const forms = await this.engine.native.form.list({ sessionID: binding.sessionId })
    const ids = new Set(forms.map((form) => form.id))
    const rows = this.store.db
      .query("SELECT id FROM platform_questions WHERE bindingId=? AND state<>'closed'")
      .all(binding.id) as { id: string }[]
    for (const row of rows) {
      if (!ids.has(row.id)) {
        this.closed(row.id)
        this.notice(binding, `question-expired:${row.id}`, '先前的问题已结束或因服务重启失效。需要继续时请重新 @ 我。')
      }
    }
    for (const form of forms) await this.created(binding, form)
  }

  async created(binding: Binding, form: Form) {
    const adapter = this.adapter(binding.adapterId)
    if (binding.archivedAt || adapter.platform === 'web') return
    return this.serial(`form:${form.id}`, async () => {
      let question = this.get(form.id)
      if (!question) {
        const tool = form.metadata?.tool
        const messageId =
          tool && typeof tool === 'object' && !Array.isArray(tool) && typeof tool.messageID === 'string'
            ? tool.messageID
            : undefined
        const inputId = messageId ? await this.engine.inputForAssistant(binding.sessionId, messageId) : binding.inputId
        const input = inputId ? this.store.inbound(inputId) : undefined
        const root = input ? this.store.inbound(input.rootId) : undefined
        if (
          !root ||
          root.message.author.bot ||
          form.metadata?.kind !== 'question' ||
          form.fields.some(
            (field) => !['string', 'multiselect'].includes(field.type) || ('when' in field && field.when?.length)
          )
        ) {
          this.notice(binding, `form:${form.id}`, '有待填写的交互表单，请在 WebUI 中处理。')
          return
        }
        this.store.db
          .query(
            'INSERT OR IGNORE INTO platform_questions(id,bindingId,inputId,targetId,form,createdAt) VALUES(?,?,?,?,?,?)'
          )
          .run(form.id, binding.id, inputId ?? null, root.message.author.id, JSON.stringify(form), Date.now())
        question = this.get(form.id)!
      }
      if (question.state === 'closed') return
      if (question.state === 'submitting') await this.finish(question)
      else if ((await this.state(question))?.status === 'pending') {
        this.present(question)
      } else this.closed(form.id)
    })
  }

  closed(id: string) {
    const question = this.get(id)
    if (!question) return
    this.store.db.query("UPDATE platform_questions SET state='closed' WHERE id=?").run(id)
    const prefix = `question:${id}:`
    this.store.db
      .query(
        "DELETE FROM outbound WHERE bindingId=? AND substr(sourceId,1,?)=? AND state IN ('pending','failed') AND messageId IS NULL"
      )
      .run(question.bindingId, prefix.length, prefix)
  }

  closeBinding(bindingId: string) {
    const rows = this.store.db
      .query("SELECT id FROM platform_questions WHERE bindingId=? AND state<>'closed'")
      .all(bindingId) as { id: string }[]
    for (const row of rows) this.closed(row.id)
  }

  private candidates(adapterId: string, message: IncomingMessage) {
    const rows = this.store.db
      .query(
        `
      SELECT q.id FROM platform_questions q JOIN bindings b ON b.id=q.bindingId
      WHERE b.adapterId=? AND b.archivedAt IS NULL AND b.deletedAt IS NULL AND q.targetId=? AND q.state<>'closed'
      AND (b.conversationId=? OR ?='direct') ORDER BY q.createdAt,q.id
    `
      )
      .all(adapterId, message.author.id, message.address.id, message.address.kind) as { id: string }[]
    return rows.map((row) => this.get(row.id)!)
  }

  expects(adapterId: string, message: IncomingMessage) {
    return !message.author.bot && this.candidates(adapterId, message).length > 0
  }

  private peers(adapterId: string, message: IncomingMessage): Adapter[] {
    if (message.address.kind !== 'channel') return []
    const adapter = this.adapter(adapterId)
    const key = adapter.conversationKey?.(message.address)
    if (!key) return []
    const rows = this.store.db
      .query(
        `
      SELECT DISTINCT b.adapterId FROM platform_questions q JOIN bindings b ON b.id=q.bindingId
      WHERE q.targetId=? AND q.state<>'closed' AND b.archivedAt IS NULL AND b.deletedAt IS NULL
      AND b.conversationId=? AND b.adapterId<>?
    `
      )
      .all(message.author.id, message.address.id, adapterId) as { adapterId: string }[]
    return rows.flatMap((row) => {
      try {
        const peer = this.adapter(row.adapterId)
        return peer.platform === adapter.platform && peer.conversationKey?.(message.address) === key ? [peer] : []
      } catch {
        return []
      }
    })
  }

  async receive(adapterId: string, message: IncomingMessage): Promise<boolean> {
    if (message.author.bot || !message.text.trim() || message.files?.length) return false
    const receipt = identity('msg_', adapterId, message.address.id, message.id)
    const previous = this.store.db.query('SELECT questionId FROM question_receipts WHERE id=?').get(receipt) as {
      questionId: string
    } | null
    if (!previous && !this.expects(adapterId, message)) return false
    return this.serial(`answer:${adapterId}:${message.author.id}`, async () => {
      const duplicate = this.store.db.query('SELECT questionId FROM question_receipts WHERE id=?').get(receipt) as {
        questionId: string
      } | null
      if (duplicate) {
        const question = this.get(duplicate.questionId)
        if (question?.state === 'submitting') await this.finish(question)
        return true
      }
      const pending: Question[] = []
      for (const question of this.candidates(adapterId, message)) {
        const state = await this.state(question)
        if (state?.status === 'pending') pending.push(question)
        else this.closed(question.id)
      }
      if (!pending.length) return false
      const quoted = message.quoteId
        ? pending.find((question) => {
            const field = this.field(question)
            return (
              field &&
              this.store.output(identity('out_', question.bindingId, this.source(question, field.key)))?.messageId ===
                message.quoteId
            )
          })
        : undefined
      if (
        message.quoteId &&
        !quoted &&
        this.store.db
          .query("SELECT id FROM outbound WHERE messageId=? AND sourceId LIKE 'question:%'")
          .get(message.quoteId)
      )
        return false
      const peers = this.peers(adapterId, message)
      const mentioned = message.mentions.includes(this.adapter(adapterId).identity?.id ?? '')
      const peerMentioned = peers.some((peer) => message.mentions.includes(peer.identity?.id ?? ''))
      if (!quoted && peerMentioned && !mentioned) return false
      if ((pending.length > 1 || (peers.length > 0 && (!mentioned || peerMentioned))) && !quoted) {
        this.notice(
          this.store.binding(pending[0]!.bindingId),
          `question-ambiguous:${receipt}`,
          '有多个待回答问题，请在原频道引用具体问题后回答。'
        )
        return true
      }
      const question = quoted ?? pending[0]!
      if (question.state === 'submitting') {
        await this.finish(question)
        return true
      }
      const field = this.field(question)
      if (!field || (field.type !== 'string' && field.type !== 'multiselect')) return false
      const notice = this.store.output(identity('out_', question.bindingId, this.source(question, field.key)))
      if (!notice?.messageId) return false
      const adapter = this.adapter(adapterId)
      let text = message.text.trim()
      if (adapter.identity) text = text.replaceAll(adapter.mention(adapter.identity), '').trim()
      if (!text) return false
      const options = field.options ?? []
      function selected(value: string) {
        const option = /^\d+$/.test(value) ? options[Number(value) - 1] : undefined
        return option?.value ?? options.find((option) => option.label === value)?.value ?? value
      }
      const value =
        field.type === 'multiselect'
          ? [
              ...new Set(
                text
                  .split(/[,，\n]/)
                  .map((part) => selected(part.trim()))
                  .filter(Boolean)
              ),
            ]
          : selected(text)
      const answer = { ...question.answer, [field.key]: value }
      const complete = question.form.fields.every((item) => item.key in answer)
      this.store.db.transaction(() => {
        this.store.db.query('INSERT INTO question_receipts(id,questionId) VALUES(?,?)').run(receipt, question.id)
        this.store.db
          .query('UPDATE platform_questions SET answer=?,state=? WHERE id=?')
          .run(JSON.stringify(answer), complete ? 'submitting' : 'pending', question.id)
      })()
      const updated = this.get(question.id)!
      if (complete) await this.finish(updated)
      else this.present(updated)
      return true
    })
  }

  private field(question: Question) {
    return question.form.fields.find((field) => !(field.key in question.answer))
  }

  private source(question: Question, key: string) {
    return `question:${question.id}:${key}`
  }

  private present(question: Question) {
    const binding = this.store.binding(question.bindingId)
    if (binding.archivedAt || question.state !== 'pending') return
    const field = this.field(question)
    if (!field) return
    const adapter = this.adapter(binding.adapterId)
    const input = question.inputId ? this.store.inbound(question.inputId) : undefined
    const root = input ? this.store.inbound(input.rootId) : undefined
    const target = adapter.mention({ id: question.targetId, name: root?.message.author.name ?? question.targetId })
    const options = 'options' in field ? (field.options ?? []) : []
    const index = question.form.fields.indexOf(field) + 1
    const lines = [
      `${target} ${question.form.fields.length > 1 ? `(${index}/${question.form.fields.length}) ` : ''}${field.description || field.title || question.form.title}`,
      ...options.map(
        (option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`
      ),
      field.type === 'multiselect'
        ? '回复选项序号（多个用逗号分隔）或直接输入答案，无需 @。'
        : '回复选项序号或直接输入答案，无需 @。',
    ]
    this.notice(binding, this.source(question, field.key), lines.join('\n'), question.inputId)
  }

  private async state(question: Question) {
    const binding = this.store.binding(question.bindingId)
    const props = { sessionID: binding.sessionId, formID: question.id }
    return this.engine.native.form.state(props).catch((error) => {
      if ((error as { _tag?: string })._tag !== 'FormNotFoundError') throw error
      this.closed(question.id)
      this.notice(binding, `question-expired:${question.id}`, '先前的问题已失效，请重新 @ 我继续。')
      return undefined
    })
  }

  private async finish(question: Question) {
    const binding = this.store.binding(question.bindingId)
    if (binding.archivedAt) {
      this.closed(question.id)
      return
    }
    const props = { sessionID: binding.sessionId, formID: question.id }
    const state = await this.state(question)
    if (!state) return
    if (state.status === 'pending') {
      try {
        await this.engine.native.form.reply({ ...props, answer: question.answer })
      } catch (error) {
        if ((await this.state(question))?.status === 'pending') throw error
      }
    }
    this.closed(question.id)
  }

  notice(binding: Binding, sourceId: string, text: string, inputId: string | null = null) {
    const output = this.store.prepareOutput(binding.id, sourceId, inputId, text, { kind: 'notice' })
    void this.enqueue(output.id)
  }
}

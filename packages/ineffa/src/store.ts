import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'

import type { Backend } from './engine'
import { type Handoff, handoffPrompt } from './handoff'
import type { Address, Attachment, Binding, Inbound, Outbound, OutputKind } from './types'
import { IneffaError } from './types'

export function identity(prefix: string, ...parts: string[]) {
  return prefix + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}
type Row = Record<string, unknown>
function binding(row: Row): Binding {
  return {
    ...row,
    address: JSON.parse(String(row.address)),
    debug: Boolean(row.debug),
    model: row.model ?? undefined,
    predecessorId: row.predecessorId ?? undefined,
  } as Binding
}
function inbound(row: Row): Inbound {
  return {
    ...row,
    message: JSON.parse(String(row.message)),
    command: row.command ? JSON.parse(String(row.command)) : undefined,
  } as Inbound
}
function outbound(row: Row): Outbound {
  return {
    ...row,
    files: row.files ? JSON.parse(String(row.files)) : undefined,
    notes: row.notes ? JSON.parse(String(row.notes)) : undefined,
    relayed: Boolean(row.relayed),
    complete: Boolean(row.complete),
  } as Outbound
}

export class Store {
  readonly db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    const version = this.db.query('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version > 10) throw new Error('投递数据库来自较新的 Ineffa 版本，请恢复配套备份。')
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bindings (
          id TEXT PRIMARY KEY, adapterId TEXT NOT NULL, conversationId TEXT NOT NULL, address TEXT NOT NULL,
          agent TEXT NOT NULL, directory TEXT NOT NULL, sessionId TEXT NOT NULL UNIQUE,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER,
          cursor INTEGER NOT NULL DEFAULT 0, inputId TEXT, engineReady INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS active_address ON bindings(adapterId, conversationId) WHERE archivedAt IS NULL;
        CREATE TABLE IF NOT EXISTS inbound (
          id TEXT PRIMARY KEY, bindingId TEXT NOT NULL REFERENCES bindings(id), message TEXT NOT NULL,
          prompt TEXT NOT NULL, rootId TEXT NOT NULL, bot INTEGER NOT NULL,
          state TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS inbound_root ON inbound(rootId, bot);
        CREATE INDEX IF NOT EXISTS inbound_state ON inbound(state);
        CREATE TABLE IF NOT EXISTS outbound (
          id TEXT PRIMARY KEY, bindingId TEXT NOT NULL REFERENCES bindings(id), sourceId TEXT NOT NULL,
          inputId TEXT, text TEXT NOT NULL, state TEXT NOT NULL, messageId TEXT, error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, relayed INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL,
          UNIQUE(bindingId, sourceId)
        );
        CREATE INDEX IF NOT EXISTS outbound_state ON outbound(state);
        CREATE TABLE IF NOT EXISTS debug_reports (
          messageId TEXT PRIMARY KEY, bindingId TEXT NOT NULL REFERENCES bindings(id), report TEXT NOT NULL
        );
      `)
      if (version.user_version < 2) this.db.exec('ALTER TABLE bindings ADD COLUMN deletedAt INTEGER;')
      if (version.user_version < 3) this.db.exec('ALTER TABLE inbound ADD COLUMN command TEXT;')
      if (version.user_version < 4) this.db.exec('ALTER TABLE bindings ADD COLUMN debug INTEGER NOT NULL DEFAULT 0;')
      if (version.user_version < 5)
        this.db.exec(`
        ALTER TABLE outbound ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply';
        ALTER TABLE outbound ADD COLUMN complete INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE outbound ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE outbound ADD COLUMN deliveredRevision INTEGER NOT NULL DEFAULT -1;
        ALTER TABLE outbound ADD COLUMN sendingRevision INTEGER NOT NULL DEFAULT 0;
        UPDATE outbound SET deliveredRevision=0 WHERE state='sent';
      `)
      if (version.user_version < 6)
        this.db.exec(`
        ALTER TABLE inbound ADD COLUMN contextInputId TEXT;
        CREATE INDEX inbound_context ON inbound(bindingId,state,contextInputId);
      `)
      if (version.user_version < 7) {
        this.db.exec(`
          ALTER TABLE outbound ADD COLUMN files TEXT;
          CREATE TABLE platform_questions (
            id TEXT PRIMARY KEY, bindingId TEXT NOT NULL REFERENCES bindings(id), inputId TEXT,
            targetId TEXT NOT NULL, form TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '{}',
            state TEXT NOT NULL DEFAULT 'pending', createdAt INTEGER NOT NULL
          );
          CREATE INDEX platform_questions_pending ON platform_questions(state,bindingId,targetId);
          CREATE TABLE question_receipts (
            id TEXT PRIMARY KEY, questionId TEXT NOT NULL REFERENCES platform_questions(id)
          );
        `)
      }
      if (version.user_version < 8) this.db.exec('ALTER TABLE outbound ADD COLUMN notes TEXT;')
      if (version.user_version < 9) {
        this.db.exec(
          "ALTER TABLE bindings ADD COLUMN backend TEXT NOT NULL DEFAULT 'opencode'; ALTER TABLE bindings ADD COLUMN model TEXT;"
        )
      }
      if (version.user_version < 10) {
        this.db.exec(`ALTER TABLE bindings ADD COLUMN predecessorId TEXT;
          ALTER TABLE inbound ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
          CREATE UNIQUE INDEX handoff_successor ON bindings(predecessorId) WHERE predecessorId IS NOT NULL;
          CREATE TABLE handoffs (bindingId TEXT PRIMARY KEY REFERENCES bindings(id), entries TEXT NOT NULL,
            truncated INTEGER NOT NULL, inputId TEXT);
        `)
      }
      this.db.exec('PRAGMA user_version=10;')
    })()
    // A process may have died after the remote side accepted a send. Do not resend blindly.
    this.db
      .query(
        "UPDATE outbound SET state='unknown', error='发送过程中服务退出，平台接收结果尚未确认。' WHERE state='sending'"
      )
      .run()
  }
  close() {
    this.db.close()
  }
  bindings(archived = false): Binding[] {
    return (
      this.db
        .query(
          `SELECT * FROM bindings WHERE deletedAt IS NULL ${archived ? '' : 'AND archivedAt IS NULL'} ORDER BY updatedAt DESC`
        )
        .all() as Row[]
    ).map(binding)
  }
  binding(id: string) {
    const row = this.db.query('SELECT * FROM bindings WHERE id=? AND deletedAt IS NULL').get(id) as Row | null
    if (!row) throw new IneffaError('conversation_not_found', '此会话不存在。', 404)
    return binding(row)
  }
  bySession(id: string) {
    const row = this.db.query('SELECT * FROM bindings WHERE sessionId=? AND deletedAt IS NULL').get(id) as Row | null
    return row ? binding(row) : undefined
  }
  current(adapterId: string, conversationId: string) {
    const row = this.db
      .query('SELECT * FROM bindings WHERE adapterId=? AND conversationId=? AND archivedAt IS NULL')
      .get(adapterId, conversationId) as Row | null
    return row ? binding(row) : undefined
  }
  ensure(
    adapterId: string,
    address: Address,
    agent: string,
    directory: string,
    backend: Backend = 'opencode',
    model?: string
  ): Binding {
    return this.db.transaction(() => {
      const previous = this.current(adapterId, address.id)
      if (previous) return previous
      const id = randomUUID()
      const now = Date.now()
      this.db
        .query(
          'INSERT INTO bindings(id,adapterId,conversationId,address,agent,directory,sessionId,createdAt,updatedAt,backend,model) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          id,
          adapterId,
          address.id,
          JSON.stringify(address),
          agent,
          directory,
          `ses_${id.replaceAll('-', '')}`,
          now,
          now,
          backend,
          model ?? null
        )
      return this.binding(id)
    })()
  }
  successor(id: string) {
    const row = this.db
      .query('SELECT * FROM bindings WHERE predecessorId=? AND deletedAt IS NULL')
      .get(id) as Row | null
    return row ? binding(row) : undefined
  }
  continues(id: string): boolean {
    const row = this.db
      .query(
        `
      WITH RECURSIVE lineage(id,archivedAt) AS (
        SELECT id,archivedAt FROM bindings WHERE id=? AND deletedAt IS NULL
        UNION ALL SELECT b.id,b.archivedAt FROM bindings b JOIN lineage l ON b.predecessorId=l.id WHERE b.deletedAt IS NULL
      ) SELECT 1 FROM lineage WHERE archivedAt IS NULL LIMIT 1
    `
      )
      .get(id)
    return Boolean(row)
  }
  handoff(id: string): Handoff | undefined {
    const row = this.db.query('SELECT entries,truncated,inputId FROM handoffs WHERE bindingId=?').get(id) as {
      entries: string
      truncated: number
      inputId: string | null
    } | null
    return row
      ? { entries: JSON.parse(row.entries), truncated: Boolean(row.truncated), inputId: row.inputId ?? undefined }
      : undefined
  }
  consumedBackground(id: string): Inbound[] {
    return (
      this.db
        .query(
          "SELECT * FROM inbound WHERE bindingId=? AND state='observed' AND contextInputId IS NOT NULL ORDER BY createdAt DESC LIMIT 300"
        )
        .all(id) as Row[]
    ).map(inbound)
  }
  settleInputs(bindingId: string, ids: Iterable<string>) {
    this.db.transaction(() => {
      const query = this.db.query('UPDATE inbound SET settled=1 WHERE bindingId=? AND id=?')
      for (const id of ids) query.run(bindingId, id)
    })()
  }
  assertHandoffReady(id: string) {
    if (
      this.db
        .query("SELECT 1 FROM inbound WHERE bindingId=? AND state='admitted' AND command IS NULL AND settled=0 LIMIT 1")
        .get(id)
    )
      throw new IneffaError('session_settling', '会话记录仍在更新，请稍后切换。', 409)
    if (
      this.db
        .query("SELECT 1 FROM inbound WHERE bindingId=? AND state IN ('pending','failed','unknown') LIMIT 1")
        .get(id)
    )
      throw new IneffaError('handoff_pending_input', '请先处理排队、失败或结果未知的输入。', 409)
    if (
      this.db
        .query(
          "SELECT 1 FROM outbound WHERE bindingId=? AND (state<>'sent' OR complete=0 OR deliveredRevision<revision OR relayed=0) LIMIT 1"
        )
        .get(id)
    )
      throw new IneffaError('handoff_pending_delivery', '请等待消息送达并处理失败或结果未知的投递。', 409)
    if (this.db.query("SELECT 1 FROM platform_questions WHERE bindingId=? AND state<>'closed' LIMIT 1").get(id))
      throw new IneffaError('handoff_pending_question', '请先回答或取消待处理的问题。', 409)
  }
  commitHandoff(previousId: string, next: Binding, transfer: Handoff): Binding {
    return this.db.transaction(() => {
      const previous = this.binding(previousId)
      if (previous.archivedAt || this.current(previous.adapterId, previous.address.id)?.id !== previousId)
        throw new IneffaError('handoff_changed', '会话已变化，请重新选择当前会话。', 409)
      this.assertHandoffReady(previousId)
      this.archive(previousId)
      this.db
        .query(
          `INSERT INTO bindings(id,adapterId,conversationId,address,agent,directory,sessionId,createdAt,updatedAt,backend,model,debug,engineReady,predecessorId)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`
        )
        .run(
          next.id,
          next.adapterId,
          next.address.id,
          JSON.stringify(next.address),
          next.agent,
          next.directory,
          next.sessionId,
          next.createdAt,
          next.updatedAt,
          next.backend,
          next.model ?? null,
          next.debug ? 1 : 0,
          previousId
        )
      this.db
        .query('INSERT INTO handoffs(bindingId,entries,truncated) VALUES(?,?,?)')
        .run(next.id, JSON.stringify(transfer.entries), transfer.truncated ? 1 : 0)
      this.db
        .query("UPDATE inbound SET bindingId=? WHERE bindingId=? AND state='observed' AND contextInputId IS NULL")
        .run(next.id, previousId)
      return this.binding(next.id)
    })()
  }
  rename(id: string, title: string) {
    const b = this.binding(id)
    this.db
      .query('UPDATE bindings SET address=?,updatedAt=? WHERE id=?')
      .run(JSON.stringify({ ...b.address, title }), Date.now(), id)
  }
  archive(id: string) {
    this.db.query('UPDATE bindings SET archivedAt=?,updatedAt=? WHERE id=?').run(Date.now(), Date.now(), id)
  }
  replace(binding: Binding, input?: Inbound): Binding {
    return this.db.transaction(() => {
      this.archive(binding.id)
      const next = this.ensure(
        binding.adapterId,
        binding.address,
        binding.agent,
        binding.directory,
        binding.backend,
        binding.model
      )
      this.setDebug(next.id, binding.debug)
      // Commit the new binding and the command receipt together: a duplicate /new cannot reset twice.
      if (input) this.admit({ ...input, bindingId: next.id })
      return this.binding(next.id)
    })()
  }
  remove(id: string) {
    this.db.transaction(() => {
      this.binding(id)
      this.db
        .query(
          'DELETE FROM question_receipts WHERE questionId IN (SELECT id FROM platform_questions WHERE bindingId=?)'
        )
        .run(id)
      this.db.query('DELETE FROM platform_questions WHERE bindingId=?').run(id)
      this.db.query('DELETE FROM outbound WHERE bindingId=?').run(id)
      this.db.query('DELETE FROM inbound WHERE bindingId=?').run(id)
      this.db.query('DELETE FROM debug_reports WHERE bindingId=?').run(id)
      this.db.query('DELETE FROM handoffs WHERE bindingId=?').run(id)
      this.db.query('UPDATE bindings SET predecessorId=NULL WHERE predecessorId=?').run(id)
      // Retain the address boundary so late reports cannot revive a deleted conversation.
      const now = Date.now()
      this.db
        .query(
          'UPDATE bindings SET deletedAt=?,archivedAt=COALESCE(archivedAt,?),updatedAt=?,inputId=NULL,cursor=0 WHERE id=?'
        )
        .run(now, now, now, id)
    })()
  }
  ready(id: string) {
    this.db.query('UPDATE bindings SET engineReady=1 WHERE id=?').run(id)
  }
  setDebug(id: string, enabled: boolean) {
    this.db.query('UPDATE bindings SET debug=? WHERE id=?').run(enabled ? 1 : 0, id)
  }
  setAgent(id: string, agent: string) {
    this.db.query('UPDATE bindings SET agent=?,updatedAt=? WHERE id=?').run(agent, Date.now(), id)
  }
  saveDebugReport(bindingId: string, messageId: string, report: string) {
    this.db
      .query('INSERT OR IGNORE INTO debug_reports(messageId,bindingId,report) VALUES(?,?,?)')
      .run(messageId, bindingId, report)
  }
  debugReport(messageId: string): string {
    const row = this.db.query('SELECT report FROM debug_reports WHERE messageId=?').get(messageId) as {
      report: string
    } | null
    return row?.report ?? ''
  }
  contextQuote(text: string, messageId?: string): string {
    const row = this.db
      .query(
        `
      SELECT o.text, o.kind, o.sourceId FROM outbound o
      LEFT JOIN debug_reports d ON d.messageId=o.sourceId
      WHERE o.text=? OR o.text || COALESCE(d.report, '')=? OR o.messageId=? LIMIT 1
    `
      )
      .get(text, text, messageId ?? null) as { text: string; kind: string; sourceId: string } | null
    if (!row) return text
    if (!['reply', 'attachment'].includes(row.kind) || /^(command|input-error|limit):/.test(row.sourceId)) return ''
    return row.text
  }
  checkpoint(id: string, cursor: number, inputId?: string) {
    this.db
      .query('UPDATE bindings SET cursor=?, inputId=COALESCE(?,inputId), updatedAt=? WHERE id=?')
      .run(cursor, inputId ?? null, Date.now(), id)
  }
  inbound(id: string) {
    const row = this.db.query('SELECT * FROM inbound WHERE id=?').get(id) as Row | null
    return row ? inbound(row) : undefined
  }
  observed(bindingId: string, unread = true): Inbound[] {
    const rows = this.db
      .query(
        `
      SELECT * FROM inbound WHERE bindingId=? AND state='observed'
      ${unread ? 'AND contextInputId IS NULL ORDER BY createdAt,rowid' : 'ORDER BY createdAt DESC,rowid DESC LIMIT 100'}
    `
      )
      .all(bindingId) as Row[]
    return rows.map(inbound)
  }
  contextFiles(inputId: string) {
    const rows = this.db
      .query("SELECT * FROM inbound WHERE contextInputId=? AND state='observed' ORDER BY createdAt,rowid")
      .all(inputId) as Row[]
    return rows.flatMap((row) => inbound(row).message.files ?? [])
  }
  admit(item: Inbound, context: Inbound[] = []): { item: Inbound; fresh: boolean } {
    return this.db.transaction(() => {
      const existing = this.inbound(item.id)
      if (existing) return { item: existing, fresh: false }
      const transfer = !item.command && item.state === 'pending' ? this.handoff(item.bindingId) : undefined
      if (transfer && !transfer.inputId) {
        item = { ...item, prompt: [handoffPrompt(transfer), item.prompt].join('\n\n') }
        this.db
          .query('UPDATE handoffs SET inputId=? WHERE bindingId=? AND inputId IS NULL')
          .run(item.id, item.bindingId)
      }
      this.db
        .query(
          'INSERT INTO inbound(id,bindingId,message,prompt,rootId,bot,state,createdAt,command) VALUES(?,?,?,?,?,?,?,?,?)'
        )
        .run(
          item.id,
          item.bindingId,
          JSON.stringify(item.message),
          item.prompt,
          item.rootId,
          item.message.author.bot ? 1 : 0,
          item.state,
          item.createdAt,
          item.command ? JSON.stringify(item.command) : null
        )
      for (const message of context) {
        this.db
          .query(
            "UPDATE inbound SET contextInputId=? WHERE id=? AND bindingId=? AND state='observed' AND contextInputId IS NULL"
          )
          .run(item.id, message.id, item.bindingId)
      }
      return { item, fresh: true }
    })()
  }
  inboundState(id: string, state: Inbound['state'], error: string | null = null) {
    this.db.transaction(() => {
      this.db.query('UPDATE inbound SET state=?,error=? WHERE id=?').run(state, error, id)
      if (state === 'cancelled') {
        this.db.query('UPDATE inbound SET contextInputId=NULL WHERE contextInputId=?').run(id)
        this.db.query('UPDATE handoffs SET inputId=NULL WHERE inputId=?').run(id)
      }
    })()
  }
  pendingInputs() {
    return (this.db.query("SELECT * FROM inbound WHERE state='pending' ORDER BY createdAt,rowid").all() as Row[]).map(
      inbound
    )
  }
  failedInputs() {
    return (
      this.db
        .query("SELECT * FROM inbound WHERE state IN ('failed','unknown') ORDER BY createdAt DESC LIMIT 100")
        .all() as Row[]
    ).map(inbound)
  }
  hasResetSince(adapterId: string, addressId: string, since: number) {
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM bindings b WHERE adapterId=? AND conversationId=? AND archivedAt>=?
          AND NOT EXISTS (SELECT 1 FROM bindings n WHERE n.predecessorId=b.id AND n.deletedAt IS NULL) LIMIT 1`
        )
        .get(adapterId, addressId, since)
    )
  }
  prepareOutput(
    bindingId: string,
    sourceId: string,
    inputId: string | null,
    text: string,
    options: { complete?: boolean; kind?: OutputKind; files?: Attachment[]; notes?: string[] } = {}
  ) {
    const id = identity('out_', bindingId, sourceId)
    const complete = options.complete ?? true
    const files = options.files?.length ? JSON.stringify(options.files) : null
    const notes = options.notes?.length ? JSON.stringify(options.notes) : null
    this.db
      .query(
        "INSERT OR IGNORE INTO outbound(id,bindingId,sourceId,inputId,text,files,notes,state,createdAt,kind,complete) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)"
      )
      .run(id, bindingId, sourceId, inputId, text, files, notes, Date.now(), options.kind ?? 'reply', complete ? 1 : 0)
    this.db
      .query(
        `UPDATE outbound SET text=?,files=?,notes=?,inputId=?,complete=?,revision=revision+1,attempts=0,
      state=CASE WHEN state='sent' THEN 'pending' ELSE state END
      WHERE id=? AND complete=0 AND (text<>? OR files IS NOT ? OR notes IS NOT ? OR complete<>? OR inputId IS NOT ?)`
      )
      .run(text, files, notes, inputId, complete ? 1 : 0, id, text, files, notes, complete ? 1 : 0, inputId)
    return this.output(id)!
  }
  output(id: string) {
    const row = this.db.query('SELECT * FROM outbound WHERE id=?').get(id) as Row | null
    return row ? outbound(row) : undefined
  }
  outputs(recovery = false) {
    const sql = recovery
      ? "SELECT * FROM outbound WHERE state='pending' OR (state='sent' AND complete=1 AND relayed=0) ORDER BY createdAt,rowid"
      : 'SELECT * FROM outbound ORDER BY createdAt DESC LIMIT 100'
    return (this.db.query(sql).all() as Row[]).map(outbound)
  }
  commandNotices(bindingId: string) {
    return (
      this.db
        .query(
          "SELECT * FROM outbound WHERE bindingId=? AND (sourceId LIKE 'command:%' OR kind<>'reply') ORDER BY createdAt DESC LIMIT 100"
        )
        .all(bindingId) as Row[]
    ).map(outbound)
  }
  outputState(
    id: string,
    state: Outbound['state'],
    error: string | null = null,
    messageId: string | null = null,
    confirmedRevision?: number
  ) {
    const current = this.output(id)
    if (!current) return
    const acknowledged = confirmedRevision ?? current.sendingRevision
    this.db
      .query(
        `UPDATE outbound SET state=?,error=?,messageId=COALESCE(?,messageId),attempts=attempts+?,
        sendingRevision=?,deliveredRevision=? WHERE id=?`
      )
      .run(
        state === 'sent' && acknowledged < current.revision ? 'pending' : state,
        error,
        messageId,
        state === 'sending' ? 1 : 0,
        state === 'sending' ? current.revision : current.sendingRevision,
        state === 'sent' ? Math.max(current.deliveredRevision, acknowledged) : current.deliveredRevision,
        id
      )
  }
  relayError(id: string, error: string) {
    this.db.query("UPDATE outbound SET error=? WHERE id=? AND state='sent' AND relayed=0").run(error, id)
  }
  relayed(id: string) {
    this.db.query('UPDATE outbound SET relayed=1,error=NULL WHERE id=?').run(id)
  }
}

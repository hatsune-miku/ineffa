import { Database } from 'bun:sqlite'

import type { EngineEvent, EngineForm, FormAnswer } from './engine'
import type { Attachment, Inbound } from './types'

export type PiSessionRecord = {
  id: string
  directory: string
  file: string
  title: string
  model: string
  agent: string
}

export type PiInput = {
  id: string
  sessionId: string
  state: 'queued' | 'running' | 'done' | 'interrupted' | 'cancelled'
  input: Inbound
  files: Attachment[]
}

/** Delivery bookkeeping only. Pi's JSONL remains the authoritative model transcript. */
export class PiJournal {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, directory TEXT NOT NULL, file TEXT NOT NULL,
        title TEXT NOT NULL, model TEXT NOT NULL, agent TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inputs (
        position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL, input TEXT NOT NULL, files TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        entryId TEXT, inputId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, event TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forms (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        form TEXT NOT NULL, status TEXT NOT NULL, answer TEXT
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(sessionId, seq);
      CREATE INDEX IF NOT EXISTS inputs_session ON inputs(sessionId, state, position);
    `)
  }

  session(id: string) {
    return this.db.query('SELECT * FROM sessions WHERE id=?').get(id) as PiSessionRecord | null
  }

  addSession(record: PiSessionRecord) {
    this.db
      .query('INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.directory, record.file, record.title, record.model, record.agent)
  }

  input(id: string): PiInput | undefined {
    const row = this.db.query('SELECT * FROM inputs WHERE id=?').get(id) as
      (Omit<PiInput, 'input' | 'files'> & { input: string; files: string }) | null
    return row ? { ...row, input: JSON.parse(row.input), files: JSON.parse(row.files) } : undefined
  }

  accept(sessionId: string, input: Inbound, files: Attachment[]) {
    this.db
      .query("INSERT OR IGNORE INTO inputs(id,sessionId,state,input,files) VALUES(?,?,'queued',?,?)")
      .run(input.id, sessionId, JSON.stringify(input), JSON.stringify(files))
  }

  pending(sessionId: string) {
    return (
      this.db.query("SELECT id FROM inputs WHERE sessionId=? AND state='queued' ORDER BY position").all(sessionId) as {
        id: string
      }[]
    ).map((row) => this.input(row.id)!)
  }

  state(id: string, state: PiInput['state']) {
    this.db.query('UPDATE inputs SET state=? WHERE id=?').run(state, id)
  }

  append(sessionId: string, event: EngineEvent) {
    const result = this.db
      .query('INSERT INTO events(sessionId,event) VALUES(?,?)')
      .run(sessionId, JSON.stringify(event))
    return { ...event, durable: { seq: Number(result.lastInsertRowid) } }
  }

  events(sessionId: string, cursor: number) {
    return (
      this.db
        .query('SELECT seq,event FROM events WHERE sessionId=? AND seq>? ORDER BY seq LIMIT 200')
        .all(sessionId, cursor) as { seq: number; event: string }[]
    ).map((row) => ({ ...JSON.parse(row.event), durable: { seq: row.seq } }) as EngineEvent)
  }

  message(id: string) {
    return this.db.query('SELECT * FROM messages WHERE id=?').get(id) as {
      id: string
      sessionId: string
      entryId: string | null
      inputId: string
    } | null
  }

  mapMessage(id: string, sessionId: string, inputId: string, entryId?: string) {
    this.db
      .query(
        `INSERT INTO messages VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET entryId=COALESCE(excluded.entryId,messages.entryId)`
      )
      .run(id, sessionId, entryId ?? null, inputId)
  }

  form(id: string) {
    const row = this.db.query('SELECT form,status,answer FROM forms WHERE id=?').get(id) as {
      form: string
      status: string
      answer: string | null
    } | null
    return row
      ? {
          form: JSON.parse(row.form) as EngineForm,
          status: row.status,
          answer: row.answer ? (JSON.parse(row.answer) as FormAnswer) : undefined,
        }
      : undefined
  }

  addForm(form: EngineForm) {
    this.db.query("INSERT INTO forms VALUES(?,?,?,'pending',NULL)").run(form.id, form.sessionID, JSON.stringify(form))
  }

  finishForm(id: string, status: string, answer?: FormAnswer) {
    this.db
      .query('UPDATE forms SET status=?,answer=? WHERE id=?')
      .run(status, answer ? JSON.stringify(answer) : null, id)
  }

  /** Never replay an interrupted tool or API call after a process failure. */
  recover() {
    const sessions = this.db.query("SELECT DISTINCT sessionId FROM inputs WHERE state='running'").all() as {
      sessionId: string
    }[]
    this.db.transaction(() => {
      this.db.query("UPDATE inputs SET state='interrupted' WHERE state='running'").run()
      this.db.query("UPDATE forms SET status='cancelled' WHERE status='pending'").run()
      for (const { sessionId } of sessions) {
        this.append(sessionId, {
          type: 'session.execution.interrupted',
          data: { sessionID: sessionId },
          created: Date.now(),
        })
      }
    })()
  }
}

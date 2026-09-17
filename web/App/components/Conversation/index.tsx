import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Alert, Badge, Button, ComboBox, TextArea } from '@a1knla/cakeui'

import { FormRequest } from './components/FormRequest'
import { Message } from './components/Message'
import { PermissionRequest } from './components/PermissionRequest'

import type { MessageView } from '../../../../src/view'
import { type ConversationDetail, api } from '../../../api'
import { Icon } from '../../../components/Icon'
import { IconButton } from '../../../components/IconButton'
import { messageOf } from '../../../utils'

import './index.css'

type Submitted = { text: string; id: string; mode: string }

function savedDraft(id: string): { text: string; pending?: Submitted } {
  try {
    const raw = sessionStorage.getItem(`draft:${id}`)
    if (!raw) return { text: '' }
    try {
      const value = JSON.parse(raw)
      if (typeof value.text === 'string') return value
    } catch {}
    return { text: raw }
  } catch {
    return { text: '' }
  }
}

export function Conversation({
  detail,
  live,
  refresh,
  select,
}: {
  detail: ConversationDetail
  live: Record<string, string>
  refresh: () => Promise<void>
  select: (id: string) => void
}) {
  const { binding } = detail
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [error, setError] = useState('')
  const [older, setOlder] = useState<MessageView[]>([])
  const [cursor, setCursor] = useState(detail.cursor)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [busy, setBusy] = useState(false)
  const [initialDraft] = useState(() => savedDraft(binding.id))
  const [draft, setDraft] = useState(initialDraft.text)
  const [mode, setMode] = useState(initialDraft.pending?.mode ?? 'queue')
  const [sending, setSending] = useState(false)
  const submitted = useRef<Submitted | null>(initialDraft.pending ?? null)
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const merged = [...older.filter((m) => !detail.messages.some((n) => n.id === m.id)), ...detail.messages]
  const messages: MessageView[] = merged.map((message) => ({
    ...message,
    text:
      !message.completed && live[message.id] && live[message.id]!.length > message.text.length
        ? live[message.id]!
        : message.text,
  }))
  for (const [id, text] of Object.entries(live))
    if (!messages.some((m) => m.id === id))
      messages.push({ id, role: 'assistant', text, createdAt: Date.now(), completed: false })
  useEffect(() => {
    if (older.length === 0) setCursor(detail.cursor)
  }, [detail.cursor, older.length])
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [detail, live])
  useEffect(() => {
    try {
      sessionStorage.setItem(
        `draft:${binding.id}`,
        JSON.stringify({ text: draft, pending: submitted.current?.text === draft.trim() ? submitted.current : null })
      )
    } catch {}
  }, [draft, binding.id, sending, mode])
  useLayoutEffect(() => {
    const el = input.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }
  }, [draft])
  async function action(name: string, data: object = {}) {
    await api(`/sessions/${binding.id}/${name}`, data)
    await refresh()
  }
  async function safely(fn: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  async function send() {
    if (!draft.trim() || sending) return
    const content = draft.trim()
    if (submitted.current?.text !== content || submitted.current.mode !== mode)
      submitted.current = { text: content, id: crypto.randomUUID(), mode }
    const request = submitted.current
    setSending(true)
    setError('')
    try {
      const result = await api<{ id: string; bindingId: string; state: string; error?: string }>(
        `/sessions/${binding.id}/messages`,
        request
      )
      if (result.state === 'unknown') throw new Error(result.error ?? '命令执行结果待核实，请勿重复提交。')
      if (result.state === 'failed') await api('/deliveries/retry', { id: result.id, direction: 'inbound' })
      setDraft((value) => (value.trim() === content ? '' : value))
      submitted.current = null
      if (result.bindingId !== binding.id) {
        try {
          sessionStorage.removeItem(`draft:${binding.id}`)
        } catch {}
        select(result.bindingId)
      }
      follow.current = true
      setAtBottom(true)
      await refresh()
      input.current?.focus()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSending(false)
    }
  }
  async function loadOlder() {
    if (!cursor) return
    setLoadingOlder(true)
    setError('')
    const height = scroll.current?.scrollHeight ?? 0
    try {
      const page = await api<ConversationDetail>(`/sessions/${binding.id}?cursor=${encodeURIComponent(cursor)}`)
      setOlder((old) => [...page.messages, ...old])
      setCursor(page.cursor)
      requestAnimationFrame(() => {
        if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height
      })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setLoadingOlder(false)
    }
  }
  const writable = binding.adapterId === 'web' && !binding.archivedAt
  return (
    <>
      <div
        className="transcript"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current!
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
          setAtBottom(follow.current)
        }}
      >
        <div className="transcript-content" role="log" aria-label="会话消息" aria-live="off">
          {cursor && (
            <div className="older">
              <Button size="small" variant="ghost" loading={loadingOlder} onClick={() => void loadOlder()}>
                加载更早消息
              </Button>
            </div>
          )}
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {detail.running && (
            <div className="working-indicator" role="status">
              <span className="working-dot" />
              {detail.permissions.length ? '等待授权' : detail.forms.length ? '等待你的回复' : '正在处理'}
            </div>
          )}
          {detail.permissions.map((request) => (
            <PermissionRequest key={request.id} request={request} respond={(data) => action('permission', data)} />
          ))}
          {detail.forms.map((request) => (
            <FormRequest key={request.id} request={request} respond={(data) => action('form', data)} />
          ))}
        </div>
      </div>
      <div className="composer-area">
        <div className="composer-width">
          {!atBottom && (
            <div className="jump-latest">
              <Button
                size="small"
                onClick={() => {
                  follow.current = true
                  setAtBottom(true)
                  scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' })
                }}
              >
                <Icon name="down" />
                回到最新
              </Button>
            </div>
          )}
          {error && (
            <Alert tone="danger" className="composer-error">
              <div className="section-title">
                <span>{error}</span>
                <IconButton label="关闭提示" icon="close" onClick={() => setError('')} />
              </div>
            </Alert>
          )}
          {detail.pending.length > 0 && (
            <details className="pending-queue" open={detail.pending.length < 3}>
              <summary className="queue-summary">{detail.pending.length} 条输入等待处理</summary>
              <div>
                {detail.pending.map((item) => (
                  <div className="queue-row" key={item.id}>
                    <span className="queue-text">{item.text}</span>
                    <Badge className="queue-delivery">{item.delivery === 'steer' ? '接入当前轮' : '排队'}</Badge>
                    <IconButton
                      label="接入当前轮"
                      icon="arrow"
                      disabled={busy || item.delivery === 'steer'}
                      onClick={() => void safely(() => action('queue/steer', { id: item.id }))}
                    />
                    <IconButton
                      label="取消这条输入"
                      icon="close"
                      disabled={busy}
                      onClick={() => void safely(() => action('queue/cancel', { id: item.id }))}
                    />
                  </div>
                ))}
              </div>
            </details>
          )}
          {writable ? (
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <TextArea
                className="form-control composer-input"
                ref={input}
                aria-label="发送消息"
                placeholder="输入消息…"
                rows={2}
                maxLength={100000}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={() => {
                  composing.current = false
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    !composing.current &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="composer-toolbar">
                <ComboBox
                  className="form-control composer-mode"
                  aria-label="输入处理方式"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="queue">排队处理</option>
                  <option value="steer">接入当前轮</option>
                </ComboBox>
                <span className="grow" />
                {detail.running && (
                  <IconButton
                    label="停止并清空队列"
                    icon="stop"
                    disabled={busy}
                    onClick={() => void safely(() => action('stop'))}
                  />
                )}
                <Button
                  className="send-button"
                  type="submit"
                  variant="primary"
                  aria-label="发送"
                  disabled={!draft.trim()}
                  loading={sending}
                >
                  <Icon name="arrow" />
                </Button>
              </div>
            </form>
          ) : (
            <div className="readonly-composer">
              <Icon name={binding.archivedAt ? 'archive' : 'chat'} />
              <span>
                {binding.archivedAt ? '会话已归档，可以继续查看历史记录。' : '请在 KOOK 对应频道发言并提及这个 Agent。'}
              </span>
              {detail.running && (
                <Button size="small" disabled={busy} onClick={() => void safely(() => action('stop'))}>
                  停止
                </Button>
              )}
            </div>
          )}
          <div className="composer-note">
            <span>{writable ? 'Enter 发送 · Shift + Enter 换行' : binding.adapterId}</span>
            <span className="composer-model">{detail.info.model ? detail.info.model.id : binding.agent}</span>
          </div>
        </div>
      </div>
    </>
  )
}

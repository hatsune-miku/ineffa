import { useState } from 'react'

import { Alert, Button, ComboBox, Dialog, TextBox } from '@a1knla/cakeui'

import { type Catalog, type ConversationDetail, api } from '../../../api'
import { Icon } from '../../../components/Icon'
import { messageOf } from '../../../utils'

import './index.css'

export function ManageConversation({
  detail,
  catalog,
  close,
  changed,
}: {
  catalog: Catalog | null
  detail: ConversationDetail
  close: () => void
  changed: (id?: string) => Promise<void>
}) {
  const [title, setTitle] = useState(detail.binding.address.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState('')
  async function action(name: string, data: object = {}) {
    setBusy(true)
    setError('')
    try {
      const value = await api<{ id?: string }>(`/sessions/${detail.binding.id}/${name}`, data)
      await changed(name === 'reset' ? value.id : name === 'archive' ? '' : undefined)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) close()
      }}
      title="会话设置"
      closeLabel="关闭"
      footer={
        <Button onClick={close} disabled={busy}>
          关闭
        </Button>
      }
    >
      <div className="stack">
        {!detail.binding.archivedAt && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              void action('rename', { title })
            }}
          >
            <TextBox
              className="form-control"
              aria-label="会话名称"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              required
            />
            <Button type="submit" loading={busy}>
              保存名称
            </Button>
          </form>
        )}
        <dl className="session-facts">
          <div className="fact-row">
            <dt className="fact-label">Agent</dt>
            <dd className="fact-value">{detail.binding.agent}</dd>
          </div>
          <div className="fact-row">
            <dt className="fact-label">模型</dt>
            <dd className="fact-value">
              {detail.info.model ? `${detail.info.model.providerID}/${detail.info.model.id}` : '默认模型'}
              {detail.accountModel && <span className="muted"> · 由账号绑定</span>}
            </dd>
          </div>
          <div className="fact-row">
            <dt className="fact-label">工作目录</dt>
            <dd className="fact-value">{detail.binding.directory}</dd>
          </div>
          <div className="fact-row">
            <dt className="fact-label">输入 / 输出</dt>
            <dd className="fact-value">
              {detail.info.tokens.input.toLocaleString()} / {detail.info.tokens.output.toLocaleString()} tokens
            </dd>
          </div>
          <div className="fact-row">
            <dt className="fact-label">缓存读取</dt>
            <dd className="fact-value">{detail.info.tokens.cache.read.toLocaleString()} tokens</dd>
          </div>
          <div className="fact-row">
            <dt className="fact-label">OpenCode 会话</dt>
            <dd className="fact-value">{detail.binding.sessionId}</dd>
          </div>
        </dl>
        {!detail.binding.archivedAt && !detail.accountModel && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              void action('model', { model: new FormData(e.currentTarget).get('model') })
            }}
          >
            <ComboBox
              className="form-control"
              name="model"
              aria-label="切换模型"
              defaultValue={detail.info.model ? `${detail.info.model.providerID}/${detail.info.model.id}` : ''}
              required
            >
              <option value="">选择模型</option>
              {catalog?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.provider}
                </option>
              ))}
            </ComboBox>
            <Button type="submit" disabled={busy}>
              切换模型
            </Button>
          </form>
        )}
        {!detail.binding.archivedAt && (
          <div className="button-row">
            <Button onClick={() => setConfirm('reset')} disabled={busy}>
              重置上下文
            </Button>
            <Button onClick={() => setConfirm('archive')} disabled={busy}>
              <Icon name="archive" />
              归档会话
            </Button>
          </div>
        )}
        {confirm && (
          <Alert tone="warning">
            <p>
              {confirm === 'reset'
                ? '当前工作会停止，原会话会归档，并为这个对话创建新的上下文。'
                : '当前工作会停止并归档。历史记录仍可查看。'}
            </p>
            <div className="button-row">
              <Button variant="danger" size="small" loading={busy} onClick={() => void action(confirm)}>
                确认{confirm === 'reset' ? '重置' : '归档'}
              </Button>
              <Button size="small" variant="ghost" onClick={() => setConfirm('')}>
                取消
              </Button>
            </div>
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  )
}

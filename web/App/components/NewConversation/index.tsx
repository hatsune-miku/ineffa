import { type FormEvent, useId, useState } from 'react'

import { Alert, Button, ComboBox, Dialog, Field, TextBox } from '@a1knla/cakeui'

import { type Catalog, api } from '../../../api'
import { Loading } from '../../../components/Loading'
import { messageOf } from '../../../utils'

import './index.css'

type NewConversationProps = {
  catalog: Catalog | null
  close: () => void
  created: (id: string) => void
  inline?: boolean
}

export function NewConversation({ catalog, close, created, inline = false }: NewConversationProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const formId = useId()
  const ready = Boolean(catalog?.agents.length)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !ready) return

    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')

    try {
      const result = await api<{ id: string }>('/sessions', {
        title: data.get('title'),
        agent: data.get('agent'),
        model: data.get('model'),
      })
      created(result.id)
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const submitButton = (
    <Button form={formId} type="submit" variant="primary" loading={busy} disabled={!ready}>
      创建会话
    </Button>
  )

  const form = (
    <form id={formId} className="new-conversation-form stack" onSubmit={submit}>
      <Field label="会话名称" htmlFor={`${formId}-title`}>
        <TextBox className="form-control" id={`${formId}-title`} name="title" required maxLength={120} autoFocus />
      </Field>
      <Field label="Agent" htmlFor={`${formId}-agent`}>
        <ComboBox className="form-control" id={`${formId}-agent`} name="agent" defaultValue="build">
          {catalog?.agents.map((agent) => (
            <option value={agent.id} key={agent.id}>
              {agent.name ?? agent.id}
            </option>
          ))}
        </ComboBox>
      </Field>
      <Field label="模型" htmlFor={`${formId}-model`}>
        <ComboBox className="form-control" id={`${formId}-model`} name="model">
          <option value="">默认模型</option>
          {catalog?.models.map((model) => (
            <option value={model.id} key={model.id}>
              {model.name} · {model.provider}
            </option>
          ))}
        </ComboBox>
      </Field>
      {!ready && <Loading label="正在准备 Agent" />}
      {error && <Alert tone="danger">{error}</Alert>}
      {inline && <div className="new-conversation-actions">{submitButton}</div>}
    </form>
  )

  if (inline) {
    return (
      <section className="new-conversation-page" aria-label="新建会话">
        <div className="new-conversation-content">
          <h2 className="new-conversation-heading">新建会话</h2>
          {form}
        </div>
      </section>
    )
  }

  return (
    <Dialog
      open
      title="新建会话"
      closeLabel="关闭"
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          {submitButton}
        </>
      }
    >
      {form}
    </Dialog>
  )
}

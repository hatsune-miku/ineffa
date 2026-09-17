import { useState } from 'react'

import { Alert, Button, Dialog, Field, TextBox } from '@a1knla/cakeui'

import { api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

export function ProviderDialog({
  id,
  name,
  close,
  saved,
}: {
  id: string
  name: string
  close: () => void
  saved: () => Promise<void>
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) close()
      }}
      title={`连接 ${name}`}
      closeLabel="关闭"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" form="provider-form" variant="primary" loading={busy}>
            保存连接
          </Button>
        </>
      }
    >
      <form
        id="provider-form"
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            await api('/integrations/key', { id, key })
            setKey('')
            await saved()
          } catch (err) {
            setError(messageOf(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="API Key" htmlFor="provider-key">
          <TextBox
            className="form-control"
            id="provider-key"
            type="password"
            autoComplete="new-password"
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  )
}

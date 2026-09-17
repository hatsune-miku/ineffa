import { useState } from 'react'

import { Alert, Button, ComboBox, Dialog, Field, TextBox } from '@a1knla/cakeui'

import { api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

export function ResolveDialog({ id, close, saved }: { id: string; close: () => void; saved: () => Promise<void> }) {
  const [received, setReceived] = useState('yes')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) close()
      }}
      title="核实送达结果"
      closeLabel="关闭"
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form="resolve-delivery" variant="primary" loading={busy}>
            保存核实结果
          </Button>
        </>
      }
    >
      <form
        id="resolve-delivery"
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          setBusy(true)
          setError('')
          try {
            await api('/deliveries/resolve', { id, received: received === 'yes', messageId: data.get('messageId') })
            await saved()
          } catch (err) {
            setError(messageOf(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <p className="muted">请先在 KOOK 检查这条消息。确认送达后，其中的 Agent 提及会继续投递。</p>
        <Field label="平台上的实际结果" htmlFor="resolve-result">
          <ComboBox
            className="form-control"
            id="resolve-result"
            value={received}
            onChange={(e) => setReceived(e.target.value)}
          >
            <option value="yes">已经送达</option>
            <option value="no">确认没有送达</option>
          </ComboBox>
        </Field>
        {received === 'yes' && (
          <Field label="平台消息 ID" htmlFor="resolve-message">
            <TextBox className="form-control" id="resolve-message" name="messageId" required />
          </Field>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  )
}

import { useRef, useState } from 'react'

import { Alert, Button, Dialog } from '@a1knla/cakeui'

import { ApiError, type Conversation as ConversationInfo, api } from '../../../api'
import { messageOf } from '../../../utils'

export function DeleteConversation({
  conversation,
  close,
  deleted,
}: {
  conversation: ConversationInfo
  close: () => void
  deleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cancel = useRef<HTMLButtonElement>(null)
  async function remove() {
    setBusy(true)
    setError('')
    try {
      await api(`/sessions/${conversation.id}/delete`, {})
      deleted()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conversation_not_found') deleted()
      else setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="删除会话？"
      closeLabel="关闭"
      initialFocus={cancel}
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      footer={
        <>
          <Button ref={cancel} onClick={close} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            删除
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>“{conversation.address.title}”及其对话记录将被永久删除，无法恢复。正在进行的回复也会停止。</p>
        {conversation.adapterId !== 'web' && (
          <p className="muted">平台中的频道和消息会保留。下次收到新消息时，将开始新的会话。</p>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  )
}

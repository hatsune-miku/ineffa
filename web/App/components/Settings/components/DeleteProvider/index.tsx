import { useRef, useState } from 'react'

import { Alert, Button, Dialog } from '@a1knla/cakeui'

import { ApiError, api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

export type DeleteProviderTarget = {
  id: string
  name: string
  model?: string
  source?: 'integration'
  environment?: string[]
}

export function DeleteProvider({
  target,
  close,
  deleted,
}: {
  target: DeleteProviderTarget
  close: () => void
  deleted: (restartRequired: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cancel = useRef<HTMLButtonElement>(null)

  async function remove() {
    setBusy(true)
    setError('')
    try {
      const path = target.source === 'integration' ? '/integrations/delete' : '/providers/delete'
      const result = await api<{ restartRequired: boolean }>(path, {
        id: target.id,
        model: target.model,
      })
      await deleted(result.restartRequired)
    } catch (err) {
      if (err instanceof ApiError && ['provider_not_found', 'model_not_found'].includes(err.code)) {
        await deleted(false)
      } else {
        setError(messageOf(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      title={target.source === 'integration' ? '删除连接？' : target.model ? '删除模型？' : '删除提供方？'}
      closeLabel="关闭"
      initialFocus={cancel}
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      footer={
        <>
          <Button ref={cancel} disabled={busy} onClick={close}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            删除
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          {target.source === 'integration'
            ? `将删除 ${target.name} 的全部已保存凭据。`
            : target.model
              ? `将删除 ${target.name} 中的 ${target.model} 模型配置。`
              : `将删除 ${target.name} 的连接配置、API Key 和全部模型配置。`}
        </p>
        <p className="muted">会话历史会保留。</p>
        {Boolean(target.environment?.length) && (
          <p className="muted">环境变量仍会提供连接：{target.environment!.join('、')}。</p>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  )
}

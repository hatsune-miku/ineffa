import { useState } from 'react'

import { Alert, Button } from '@a1knla/cakeui'

import type { Permission } from '../../../../../api'
import { messageOf } from '../../../../../utils'

export function PermissionRequest({
  request,
  respond,
}: {
  request: Permission
  respond: (data: object) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function reply(value: string) {
    setBusy(true)
    setError('')
    try {
      await respond({ id: request.id, reply: value })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="request-panel" aria-label="权限请求">
      <div className="eyebrow">需要你的授权</div>
      <h3 className="request-title">{request.action}</h3>
      {request.resources.length > 0 && (
        <pre className="preformatted request-resource">{request.resources.join('\n')}</pre>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="button-row">
        <Button variant="primary" disabled={busy} onClick={() => void reply('once')}>
          允许这一次
        </Button>
        <Button disabled={busy} onClick={() => void reply('always')}>
          始终允许此规则
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void reply('reject')}>
          拒绝
        </Button>
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'

import { Alert, Button, ComboBox } from '@a1knla/cakeui'

import { type Catalog, type ConversationDetail, api } from '../../../../api'
import { messageOf } from '../../../../utils'

type Props = {
  target: NonNullable<ConversationDetail['switchTarget']>
  directory: string
  busy: boolean
  disabled: boolean
  submit: (model?: string) => Promise<void>
}

export function BackendSwitch({ target, directory, busy, disabled, submit }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [model, setModel] = useState('')
  const [error, setError] = useState('')
  const backendName = target.backend === 'pi' ? 'Pi' : 'OpenCode'

  useEffect(() => {
    if (!expanded || target.model) return
    const controller = new AbortController()
    setError('')
    const query = new URLSearchParams({ directory, backend: target.backend })
    void api<Catalog>(`/catalog?${query}`, undefined, controller.signal)
      .then(setCatalog)
      .catch((error) => {
        if (!controller.signal.aborted) setError(messageOf(error))
      })
    return () => controller.abort()
  }, [directory, expanded, target.backend, target.model])

  if (!expanded) {
    return (
      <div className="button-row">
        <Button disabled={disabled || busy} onClick={() => setExpanded(true)}>
          切换到 {backendName}
        </Button>
      </div>
    )
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        void submit(target.model || model || undefined)
      }}
    >
      <p>切换到 {backendName} 后将沿用近期对话，完整历史保存在原会话。</p>
      {target.model ? (
        <p>账号绑定模型 · {target.model}</p>
      ) : (
        <ComboBox
          className="form-control"
          aria-label={`${backendName} 模型`}
          value={model}
          disabled={busy || disabled || !catalog}
          onChange={(event) => setModel(event.target.value)}
          required={target.backend === 'pi'}
        >
          <option value="">{target.backend === 'pi' ? '选择 OpenAI 兼容模型' : '默认模型'}</option>
          {catalog?.models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} · {entry.provider}
            </option>
          ))}
        </ComboBox>
      )}
      {target.backend === 'pi' && !target.model && catalog?.models.length === 0 && (
        <Alert>请先在连接设置中添加 OpenAI 兼容模型。</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="button-row">
        <Button
          type="submit"
          loading={busy}
          disabled={disabled || (!target.model && (!catalog || (target.backend === 'pi' && !model)))}
        >
          确认切换
        </Button>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => setExpanded(false)}>
          取消
        </Button>
      </div>
    </form>
  )
}

import { useState } from 'react'

import { Alert, Button, ComboBox, Dialog, Field, TextArea, TextBox } from '@a1knla/cakeui'

import type { AgentConfig } from '../../../../../../src/opencode-settings'
import { type Catalog, api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

export function AgentDialog({
  id: initialId,
  config = {},
  catalog,
  close,
  saved,
}: {
  id?: string
  config?: AgentConfig
  catalog: Catalog | null
  close: () => void
  saved: () => Promise<void>
}) {
  const [id, setId] = useState(initialId ?? '')
  const [description, setDescription] = useState(config.description ?? '')
  const [mode, setMode] = useState(config.mode ?? 'all')
  const [model, setModel] = useState(
    typeof config.model === 'string'
      ? config.model
      : config.model
        ? `${config.model.providerID}/${config.model.model}`
        : ''
  )
  const [steps, setSteps] = useState(config.steps?.toString() ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Dialog
      open
      title={initialId ? `配置 ${initialId}` : '添加 Agent'}
      closeLabel="关闭"
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form="agent-form" variant="primary" loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <form
        id="agent-form"
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          try {
            await api('/opencode/agents/save', {
              id,
              create: !initialId,
              config: { description, mode, model, steps: steps ? Number(steps) : null },
            })
            await saved()
          } catch (error) {
            setError(messageOf(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="ID" htmlFor="AgentDialog-field-1">
          <TextBox
            id="AgentDialog-field-1"
            required
            readOnly={Boolean(initialId)}
            pattern="[a-zA-Z0-9_-]{1,100}"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
        </Field>
        <Field label="描述" htmlFor="AgentDialog-field-2">
          <TextArea
            id="AgentDialog-field-2"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="角色" htmlFor="AgentDialog-field-3">
          <ComboBox
            id="AgentDialog-field-3"
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
          >
            <option value="all">主 Agent 与子 Agent</option>
            <option value="primary">仅主 Agent</option>
            <option value="subagent">仅子 Agent</option>
          </ComboBox>
        </Field>
        <Field label="默认模型" htmlFor="AgentDialog-field-4">
          <ComboBox
            id="AgentDialog-field-4"
            searchable
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">沿用默认模型</option>
            {catalog?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.provider}
              </option>
            ))}
          </ComboBox>
        </Field>
        <Field label="单轮最大步骤" htmlFor="AgentDialog-field-5">
          <TextBox
            id="AgentDialog-field-5"
            type="number"
            min={1}
            step={1}
            placeholder="不限制"
            value={steps}
            onChange={(event) => setSteps(event.target.value)}
          />
        </Field>
        <p className="muted">身份与职责在平台账号中配置。保存后重启服务生效。</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  )
}

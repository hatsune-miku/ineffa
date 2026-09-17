import { useEffect, useRef, useState } from 'react'

import { Alert, Button, ComboBox, Dialog, Field, TextArea, TextBox } from '@a1knla/cakeui'

import { type ProviderView, api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

import './index.css'

export const agentPlan = {
  id: 'volcengine-agent-plan',
  name: 'Volcengine Agent Plan',
  baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
}

export function CustomProviderDialog({
  provider,
  preset,
  close,
  saved,
}: {
  provider?: ProviderView
  preset?: typeof agentPlan
  close: () => void
  saved: (restartRequired: boolean) => Promise<void>
}) {
  const [id, setId] = useState(provider?.id ?? preset?.id ?? '')
  const [name, setName] = useState(provider?.name ?? preset?.name ?? '')
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? preset?.baseURL ?? '')
  const [key, setKey] = useState('')
  const [models, setModels] = useState(provider?.models.join('\n') ?? '')
  const [available, setAvailable] = useState<{ id: string; name: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [error, setError] = useState('')
  const [discoveryError, setDiscoveryError] = useState('')
  const discovery = useRef<AbortController | null>(null)

  useEffect(() => () => discovery.current?.abort(), [])

  function resetDiscovery() {
    discovery.current?.abort()
    setDiscovering(false)
    setAvailable(null)
    setDiscoveryError('')
  }

  async function discover() {
    discovery.current?.abort()
    const controller = new AbortController()
    discovery.current = controller
    setDiscovering(true)
    setDiscoveryError('')
    try {
      const result = await api<{ models: { id: string; name: string }[] }>(
        '/providers/discover',
        { id, baseURL, key },
        controller.signal
      )
      if (!controller.signal.aborted) setAvailable(result.models)
    } catch (err) {
      if (!controller.signal.aborted) setDiscoveryError(messageOf(err))
    } finally {
      if (!controller.signal.aborted) setDiscovering(false)
    }
  }

  function modelIds() {
    return [...new Set(models.split(/[\s,，]+/).filter(Boolean))]
  }

  return (
    <Dialog
      open
      title={provider ? `编辑 ${provider.name}` : preset ? `连接 ${preset.name}` : '添加 OpenAI 兼容提供方'}
      closeLabel="关闭"
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button variant="primary" type="submit" form="custom-provider-form" loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <form
        id="custom-provider-form"
        className="stack custom-provider-form"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          try {
            const result = await api<{ restartRequired: boolean }>('/providers', {
              id,
              name,
              baseURL,
              key,
              models: modelIds(),
            })
            setKey('')
            await saved(result.restartRequired)
          } catch (err) {
            setError(messageOf(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="provider-identity-fields">
          <Field label="名称" htmlFor="custom-provider-name">
            <TextBox
              id="custom-provider-name"
              className="form-control"
              required
              maxLength={128}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="提供方 ID" htmlFor="custom-provider-id">
            <TextBox
              id="custom-provider-id"
              className="form-control"
              required
              maxLength={256}
              pattern={'[a-zA-Z0-9_\\-]+'}
              value={id}
              disabled={Boolean(provider) || busy}
              placeholder="my-provider"
              onChange={(event) => {
                resetDiscovery()
                setId(event.target.value)
              }}
            />
          </Field>
        </div>
        <Field label="Base URL" htmlFor="custom-provider-url">
          <TextBox
            id="custom-provider-url"
            className="form-control"
            type="url"
            required
            placeholder="https://api.example.com/v1"
            value={baseURL}
            disabled={busy}
            onChange={(event) => {
              resetDiscovery()
              setBaseURL(event.target.value)
            }}
          />
        </Field>
        <Field label="API Key" htmlFor="custom-provider-key">
          <TextBox
            id="custom-provider-key"
            className="form-control"
            type="password"
            autoComplete="new-password"
            placeholder={provider?.hasKey ? '已保存，留空保留' : '无需认证时可留空'}
            value={key}
            disabled={busy}
            onChange={(event) => {
              resetDiscovery()
              setKey(event.target.value)
            }}
          />
        </Field>
        <div className="provider-models">
          <div className="button-row">
            <Button type="button" disabled={!baseURL || busy || discovering} onClick={() => void discover()}>
              {discovering ? '正在获取模型…' : '获取模型'}
            </Button>
            {discovering && (
              <Button type="button" variant="ghost" onClick={resetDiscovery}>
                停止获取
              </Button>
            )}
            {available && <span className="muted">{available.length} 个模型</span>}
          </div>
          {discoveryError && <Alert tone="danger">{discoveryError}</Alert>}
          {available && available.length > 0 && (
            <ComboBox
              className="form-control"
              aria-label="添加可用模型"
              searchable
              searchPlaceholder="搜索模型…"
              emptyText="没有匹配的模型"
              value=""
              disabled={busy}
              onChange={(event) => {
                if (event.target.value) setModels([...new Set([...modelIds(), event.target.value])].join('\n'))
              }}
            >
              <option value="">选择要添加的模型</option>
              {available.map((model) => (
                <option key={model.id} value={model.id} disabled={modelIds().includes(model.id)}>
                  {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
                </option>
              ))}
            </ComboBox>
          )}
          {available?.length === 0 && <p className="muted">接口未返回模型，可手动填写模型 ID。</p>}
          <Field label="启用模型" htmlFor="custom-provider-models" description="每行一个模型 ID，也可直接粘贴。">
            <TextArea
              id="custom-provider-models"
              className="form-control"
              rows={4}
              required
              placeholder={preset ? 'doubao-seed-2.0-pro' : 'model-id'}
              value={models}
              disabled={busy}
              onChange={(event) => setModels(event.target.value)}
            />
          </Field>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  )
}

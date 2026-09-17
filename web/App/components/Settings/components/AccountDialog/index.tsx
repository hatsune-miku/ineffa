import { useEffect, useState } from 'react'

import { Alert, Button, ComboBox, Dialog, Field, TextArea, TextBox } from '@a1knla/cakeui'

import { type Account, type Catalog, api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

export function AccountDialog({
  account,
  catalog,
  close,
  saved,
}: {
  account?: Account
  catalog: Catalog | null
  close: () => void
  saved: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [directory, setDirectory] = useState(account?.directory ?? 'workspace')
  const [model, setModel] = useState(account?.model ?? '')
  const [localCatalog, setLocalCatalog] = useState<Catalog | null>(null)
  const [loadingModels, setLoadingModels] = useState(true)
  const [modelError, setModelError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoadingModels(true)
    setLocalCatalog(null)
    setModelError('')
    const timer = setTimeout(() => {
      api<Catalog>(`/catalog?directory=${encodeURIComponent(directory)}`, undefined, controller.signal)
        .then(setLocalCatalog)
        .catch((error) => {
          if (!controller.signal.aborted) setModelError(messageOf(error))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingModels(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [directory])
  const models = localCatalog?.models ?? []
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) close()
      }}
      title={account ? '编辑 KOOK 账号' : '添加 KOOK 账号'}
      closeLabel="关闭"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" form="account-form" variant="primary" loading={busy}>
            {account ? '保存' : '保存并连接'}
          </Button>
        </>
      }
    >
      <form
        id="account-form"
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          function ids(name: string) {
            return String(data.get(name) ?? '')
              .split(/[\s,，]+/)
              .filter(Boolean)
          }
          setBusy(true)
          setError('')
          try {
            const result = await api<{ status: { state: string; error?: string } }>(
              account ? `/adapters/${account.id}/update` : '/adapters',
              {
                id: data.get('id'),
                name: data.get('name'),
                token: data.get('token'),
                directory: data.get('directory'),
                agent: data.get('agent'),
                model,
                guilds: ids('guilds'),
                channels: ids('channels'),
                users: ids('users'),
                agentPrompt: {
                  identity: data.get('identityPrompt'),
                  task: data.get('taskPrompt'),
                },
              }
            )
            await saved()
          } catch (err) {
            setError(messageOf(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="form-grid">
          <Field label="账号 ID" htmlFor="account-id">
            <TextBox
              className="form-control"
              id="account-id"
              name="id"
              defaultValue={account?.id}
              readOnly={Boolean(account)}
              required
              pattern="[a-zA-Z0-9_-]{1,64}"
              placeholder="assistant-a"
            />
          </Field>
          <Field label="显示名称" htmlFor="account-name">
            <TextBox
              className="form-control"
              id="account-name"
              name="name"
              defaultValue={account?.name}
              placeholder="助理 A"
            />
          </Field>
        </div>
        <Field label="Bot Token" htmlFor="account-token">
          <TextBox
            className="form-control"
            id="account-token"
            name="token"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required={!account}
            placeholder={account ? '留空保留当前 Token' : ''}
          />
        </Field>
        <div className="form-grid">
          <Field label="Agent" htmlFor="account-agent">
            <ComboBox className="form-control" id="account-agent" name="agent" defaultValue={account?.agent ?? 'build'}>
              {(localCatalog ?? catalog)?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.id}
                </option>
              ))}
            </ComboBox>
          </Field>
          <Field label="工作目录" htmlFor="account-directory">
            <TextBox
              className="form-control"
              id="account-directory"
              name="directory"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              required
            />
          </Field>
        </div>
        <Field
          label="绑定模型"
          htmlFor="account-model"
          description="保存后同步已有未归档会话，不打断当前生成。解除绑定保留已有模型，新会话使用默认设置。"
        >
          <ComboBox
            className="form-control"
            id="account-model"
            name="model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            searchable
            searchPlaceholder="搜索模型或提供方…"
            disabled={loadingModels}
          >
            <option value="">{loadingModels ? '加载模型…' : '未绑定（使用默认设置）'}</option>
            {model && !models.some((item) => item.id === model) && (
              <option value={model}>
                {model}（{loadingModels ? '加载中' : '当前不可用'}）
              </option>
            )}
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.id}
              </option>
            ))}
          </ComboBox>
        </Field>
        {modelError && <Alert tone="danger">模型列表加载失败：{modelError}</Alert>}
        <Field
          label="Agent 身份"
          htmlFor="account-identity-prompt"
          description="支持 {displayName}（显示名称）、{platformId}（平台真实账号 ID）。"
        >
          <TextArea
            className="form-control"
            id="account-identity-prompt"
            name="identityPrompt"
            defaultValue={account?.agentPrompt?.identity}
            placeholder="你是 {displayName}，平台账号 ID 为 {platformId}。"
            rows={3}
            maxLength={16000}
          />
        </Field>
        <Field
          label="该做什么"
          htmlFor="account-task-prompt"
          description="这两项填写后替换 Agent 基础提示词；均留空时继承所选 Agent。保存后在下一次模型请求生效。"
        >
          <TextArea
            className="form-control"
            id="account-task-prompt"
            name="taskPrompt"
            defaultValue={account?.agentPrompt?.task}
            placeholder="协助处理群聊中的任务，通过 mention 与其他 Agent 协作。"
            rows={4}
            maxLength={16000}
          />
        </Field>
        <Field
          label="信任的服务器 ID（Guild ID）"
          htmlFor="account-guilds"
          description="允许服务器内 Bot 可访问的全部频道。用逗号或换行分隔。"
        >
          <TextArea
            className="form-control"
            id="account-guilds"
            name="guilds"
            defaultValue={account?.access?.guilds?.join('\n')}
            rows={2}
            placeholder="填写服务器数字 ID"
          />
        </Field>
        <Field
          label="允许的频道 ID"
          htmlFor="account-channels"
          description="额外允许的频道，用逗号或换行分隔。服务器和频道均留空时不接收群聊。"
        >
          <TextArea
            className="form-control"
            id="account-channels"
            name="channels"
            defaultValue={account?.access?.channels?.join('\n')}
            rows={2}
            placeholder="1234567890123456"
          />
        </Field>
        <Field label="允许私聊的用户 ID" htmlFor="account-users">
          <TextBox
            className="form-control"
            id="account-users"
            name="users"
            defaultValue={account?.access?.users?.join(', ')}
            placeholder="用逗号分隔，可留空"
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  )
}

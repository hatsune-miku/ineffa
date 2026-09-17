import { useEffect, useState } from 'react'

import { Alert, Badge, Button, ComboBox, Tab, TabList, TabPanel, Tabs } from '@a1knla/cakeui'

import { AccountDialog } from './components/AccountDialog'
import { ConfigTransfer } from './components/ConfigTransfer'
import { ConfiguredProvider } from './components/ConfiguredProvider'
import { CustomProviderDialog, agentPlan } from './components/CustomProviderDialog'
import { DeleteProvider, type DeleteProviderTarget } from './components/DeleteProvider'
import { Empty } from './components/Empty'
import { ProviderDialog } from './components/ProviderDialog'
import { ResolveDialog } from './components/ResolveDialog'

import { type Account, type Catalog, type ProviderView, api } from '../../../api'
import { Icon } from '../../../components/Icon'
import { IconButton } from '../../../components/IconButton'
import { Loading } from '../../../components/Loading'
import { messageOf, timeOf } from '../../../utils'

import './index.css'

type Delivery = {
  id: string
  bindingId: string
  text: string
  state: string
  error: string | null
  createdAt: number
  attempts?: number
  relayed?: boolean
}

type Deliveries = { inbound: Delivery[]; outbound: Delivery[] }

const statusName: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '已断开',
  error: '连接异常',
  pending: '待发送',
  sending: '发送中',
  sent: '已送达',
  failed: '发送失败',
  unknown: '结果待核实',
}

export function Settings({
  catalog,
  reloadCatalog,
  revision,
}: {
  catalog: Catalog | null
  reloadCatalog: () => Promise<void>
  revision: number
}) {
  const [tab, setTab] = useState('connections')
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [deliveries, setDeliveries] = useState<Deliveries | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Account | undefined>(undefined)
  const [resolving, setResolving] = useState<string | null>(null)
  const [provider, setProvider] = useState('')
  const [customProvider, setCustomProvider] = useState<'new' | 'agent-plan' | ProviderView | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<DeleteProviderTarget | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [onlyIssues, setOnlyIssues] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    if (tab === 'connections')
      api<{ adapters: Account[] }>('/adapters', undefined, controller.signal)
        .then((data) => {
          setAccounts(data.adapters)
          setError('')
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(messageOf(e))
        })
    else
      api<Deliveries>('/deliveries', undefined, controller.signal)
        .then((data) => {
          setDeliveries(data)
          setError('')
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(messageOf(e))
        })
    return () => controller.abort()
  }, [tab, revision])
  async function perform(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    setError('')
    try {
      await fn()
      if (tab === 'connections') setAccounts((await api<{ adapters: Account[] }>('/adapters')).adapters)
      else setDeliveries(await api<Deliveries>('/deliveries'))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy('')
    }
  }
  const outbound = deliveries?.outbound.filter(
    (d) =>
      !onlyIssues ||
      d.state === 'failed' ||
      d.state === 'unknown' ||
      (d.state === 'sent' && !d.relayed && Boolean(d.error))
  )
  const configuredProviders = catalog?.providers ?? []
  const connectedIntegrations =
    catalog?.integrations.filter(
      (integration) => integration.connected && !configuredProviders.some((item) => item.id === integration.id)
    ) ?? []
  return (
    <div className="settings-scroll">
      <div className="settings-content">
        <Tabs value={tab} onValueChange={setTab}>
          <TabList aria-label="设置分类">
            <Tab value="connections">连接</Tab>
            <Tab value="deliveries">投递记录</Tab>
          </TabList>
          {error && <Alert tone="danger">{error}</Alert>}
          {notice && <Alert>{notice}</Alert>}
          <TabPanel value="connections">
            {tab === 'connections' && (
              <>
                <section className="settings-section">
                  <div className="section-title">
                    <h2 className="section-heading">提供方与集成</h2>
                    <Badge>{connectedIntegrations.length + configuredProviders.length} 已配置</Badge>
                  </div>

                  {catalog ? (
                    <>
                      <div className="connection-list">
                        {connectedIntegrations.map((i) => (
                          <div className="connection-row" key={i.id}>
                            <span className="connection-symbol">
                              <Icon name="globe" />
                            </span>
                            <div className="grow">
                              <strong className="connection-name">{i.name}</strong>
                              <span className="muted connection-description">{i.id}</span>
                            </div>
                            <Badge className="connection-status">{i.removable ? '已配置' : '环境变量'}</Badge>
                            {i.removable && (
                              <IconButton
                                label={`删除连接 ${i.name}`}
                                icon="trash"
                                onClick={() =>
                                  setDeletingProvider({
                                    id: i.id,
                                    name: i.name,
                                    source: 'integration',
                                    environment: i.environment,
                                  })
                                }
                              />
                            )}
                          </div>
                        ))}
                        {configuredProviders.map((item) => (
                          <ConfiguredProvider
                            key={item.id}
                            provider={item}
                            edit={() => setCustomProvider(item)}
                            remove={(model) => setDeletingProvider({ id: item.id, name: item.name, model })}
                          />
                        ))}
                      </div>
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault()
                          const configured = configuredProviders.find((item) => item.id === provider)
                          if (configured) setCustomProvider(configured)
                          else if (provider === '__custom') setCustomProvider('new')
                          else if (provider === agentPlan.id) setCustomProvider('agent-plan')
                          else if (provider) setBusy(`provider:${provider}`)
                        }}
                      >
                        <ComboBox
                          className="form-control"
                          aria-label="模型提供方"
                          searchable
                          searchPlaceholder="搜索模型提供方…"
                          emptyText="没有匹配的模型提供方"
                          value={provider}
                          onChange={(e) => setProvider(e.target.value)}
                          required
                        >
                          <option value="">选择模型提供方</option>
                          <option value="__custom">自定义 OpenAI 兼容提供方</option>
                          <option value={agentPlan.id}>{agentPlan.name}</option>
                          {catalog.integrations
                            .filter((i) => i.key && i.id !== agentPlan.id)
                            .map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.name}
                              </option>
                            ))}
                        </ComboBox>
                        <Button type="submit" disabled={!provider}>
                          <Icon name="plus" />
                          连接
                        </Button>
                      </form>
                    </>
                  ) : (
                    <Loading label="正在载入模型提供方" />
                  )}
                </section>
                <section className="settings-section">
                  <div className="section-title">
                    <h2 className="section-heading">平台账号</h2>
                    <Button
                      className="settings-action"
                      size="small"
                      onClick={() => {
                        setEditing(undefined)
                        setAdding(true)
                      }}
                    >
                      <Icon name="plus" />
                      添加 KOOK 账号
                    </Button>
                  </div>
                  {accounts ? (
                    <div className="connection-list">
                      {accounts.map((a) => (
                        <div className="connection-row" key={a.id}>
                          <span className="connection-symbol">
                            <Icon name={a.platform === 'web' ? 'globe' : 'chat'} />
                          </span>
                          <div className="grow">
                            <strong className="connection-name">{a.name}</strong>
                            <span className="muted connection-description">
                              {a.platform === 'web' ? '浏览器会话' : `${a.identity?.name ?? a.id} · ${a.agent}`}
                            </span>
                            {a.model && <span className="muted connection-description">{a.model}</span>}
                            {a.status.error && <p className="error-text">{a.status.error}</p>}
                          </div>
                          <Badge
                            className="connection-status"
                            tone={
                              a.status.state === 'connected'
                                ? 'success'
                                : a.status.state === 'error'
                                  ? 'danger'
                                  : 'neutral'
                            }
                          >
                            {statusName[a.status.state] ?? a.status.state}
                          </Badge>
                          {a.editable && (
                            <IconButton
                              label="编辑账号"
                              icon="settings"
                              onClick={() => {
                                setEditing(a)
                                setAdding(true)
                              }}
                            />
                          )}
                          {a.platform !== 'web' && (
                            <IconButton
                              label="重新连接"
                              icon="retry"
                              disabled={busy === a.id}
                              onClick={() => void perform(a.id, () => api(`/adapters/${a.id}/reconnect`, {}))}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Loading />
                  )}
                </section>
                <ConfigTransfer />
                <section className="settings-section runtime-section">
                  <div>
                    <h2 className="section-heading">本地运行</h2>
                    <p className="muted runtime-version">Ineffa 0.1.0 · OpenCode 2.0.3 · Bun</p>
                  </div>
                  <Badge>进程内接入</Badge>
                </section>
              </>
            )}
          </TabPanel>
          <TabPanel value="deliveries">
            {tab === 'deliveries' && (
              <section className="settings-section">
                <div className="section-title">
                  <h2 className="section-heading">消息投递</h2>
                  <Button
                    className="settings-action"
                    size="small"
                    variant="ghost"
                    onClick={() => setOnlyIssues(!onlyIssues)}
                  >
                    {onlyIssues ? '查看最近记录' : '只看异常'}
                  </Button>
                </div>
                {!deliveries ? (
                  <Loading />
                ) : (
                  <>
                    {deliveries.inbound.length === 0 && outbound?.length === 0 && (
                      <Empty title={onlyIssues ? '没有需要处理的投递' : '还没有投递记录'}></Empty>
                    )}
                    {[
                      ...deliveries.inbound.map((d) => ({ ...d, direction: 'inbound' })),
                      ...outbound!.map((d) => ({ ...d, direction: 'outbound' })),
                    ].map((d) => (
                      <article className="delivery-row" key={d.id}>
                        <div className="section-title">
                          <span className="muted">
                            {timeOf(d.createdAt)} · {d.direction === 'inbound' ? '输入' : '回复'}
                          </span>
                          <Badge tone={d.state === 'sent' ? 'success' : d.state === 'failed' ? 'danger' : 'neutral'}>
                            {d.state === 'sent' && !d.relayed && d.error
                              ? '协作转交待重试'
                              : (statusName[d.state] ?? d.state)}
                          </Badge>
                        </div>
                        <p className="delivery-text">{d.text}</p>
                        {d.error && <p className="error-text">{d.error}</p>}
                        {d.state === 'unknown' && (
                          <p className="muted delivery-note">
                            {d.direction === 'inbound'
                              ? '命令可能已经执行。请检查会话与工作目录；确认需要后，以新消息重新发送。'
                              : '平台可能已接收这条消息。请先在平台核实，系统不会自动重发。'}
                          </p>
                        )}
                        {d.state === 'unknown' && d.direction === 'outbound' && (
                          <Button className="delivery-action" size="small" onClick={() => setResolving(d.id)}>
                            核实送达结果
                          </Button>
                        )}
                        {(d.state === 'failed' || (d.state === 'sent' && !d.relayed && d.error)) && (
                          <Button
                            className="delivery-action"
                            size="small"
                            disabled={d.state === 'failed' && (d.attempts ?? 0) >= 3}
                            loading={busy === d.id}
                            onClick={() =>
                              void perform(d.id, () => api('/deliveries/retry', { id: d.id, direction: d.direction }))
                            }
                          >
                            <Icon name="retry" />
                            {d.state === 'sent' ? '重试协作转交' : '重试'}
                          </Button>
                        )}
                      </article>
                    ))}
                  </>
                )}
              </section>
            )}
          </TabPanel>
        </Tabs>
        {resolving && (
          <ResolveDialog
            id={resolving}
            close={() => setResolving(null)}
            saved={async () => {
              setDeliveries(await api<Deliveries>('/deliveries'))
              setResolving(null)
            }}
          />
        )}
        {adding && (
          <AccountDialog
            account={editing}
            catalog={catalog}
            close={() => setAdding(false)}
            saved={async () => {
              setAccounts((await api<{ adapters: Account[] }>('/adapters')).adapters)
              setAdding(false)
            }}
          />
        )}
        {busy.startsWith('provider:') && (
          <ProviderDialog
            id={provider}
            name={catalog?.integrations.find((i) => i.id === provider)?.name ?? provider}
            close={() => setBusy('')}
            saved={async () => {
              await reloadCatalog()
              setBusy('')
            }}
          />
        )}
        {customProvider && (
          <CustomProviderDialog
            provider={typeof customProvider === 'object' ? customProvider : undefined}
            preset={customProvider === 'agent-plan' ? agentPlan : undefined}
            close={() => setCustomProvider(null)}
            saved={async (restartRequired) => {
              await reloadCatalog()
              setNotice(restartRequired ? '提供方配置已保存。OpenCode 尚未完成重载，请重启服务后使用。' : '')
              setCustomProvider(null)
            }}
          />
        )}
        {deletingProvider && (
          <DeleteProvider
            target={deletingProvider}
            close={() => setDeletingProvider(null)}
            deleted={async (restartRequired) => {
              await reloadCatalog()
              setNotice(restartRequired ? '配置已删除。OpenCode 尚未完成重载，请重启服务。' : '')
              setProvider('')
              setDeletingProvider(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

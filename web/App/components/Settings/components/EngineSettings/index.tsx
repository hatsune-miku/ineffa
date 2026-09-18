import { useEffect, useState } from 'react'

import { Alert, Badge, Button, ComboBox, Dialog, Field, TextArea, TextBox } from '@a1knla/cakeui'

import { AgentDialog } from './AgentDialog'
import { McpDialog } from './McpDialog'

import type { AgentConfig, EngineSettingsView, McpView } from '../../../../../../src/opencode-settings'
import { type Catalog, api } from '../../../../../api'
import { Loading } from '../../../../../components/Loading'
import { messageOf } from '../../../../../utils'

import './index.css'

export type EngineSection = 'mcp' | 'skills' | 'agents' | 'runtime'
const statusNames: Record<string, string> = {
  connected: '已连接',
  pending: '连接中',
  disabled: '已禁用',
  failed: '连接失败',
  needs_auth: '需要认证',
  active: '运行中',
}

export function EngineSettings({
  section,
  catalog,
  reloadCatalog,
}: {
  section: EngineSection
  catalog: Catalog | null
  reloadCatalog: () => Promise<void>
}) {
  const [directory, setDirectory] = useState('')
  const [data, setData] = useState<EngineSettingsView | null>(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [mcp, setMcp] = useState<McpView | 'new' | null>(null)
  const [agent, setAgent] = useState<{ id?: string; config?: AgentConfig } | null>(null)
  const [skill, setSkill] = useState<EngineSettingsView['skills'][number] | null>(null)
  const [deleting, setDeleting] = useState<{ type: 'mcp' | 'agents'; id: string } | null>(null)

  async function reload(signal?: AbortSignal) {
    const value = await api<EngineSettingsView>(
      `/opencode${directory ? `?directory=${encodeURIComponent(directory)}` : ''}`,
      undefined,
      signal
    )
    setData(value)
  }
  useEffect(() => {
    const controller = new AbortController()
    setData(null)
    setError('')
    void reload(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setError(messageOf(error))
    })
    return () => controller.abort()
  }, [directory])

  async function perform(path: string, value: object) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api<{ restartRequired?: boolean }>(path, value)
      setNotice(result.restartRequired ? '已保存，重启服务后完整生效。' : '已更新。')
      await reload()
      await reloadCatalog()
      setDeleting(null)
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  function matches(...values: (string | undefined)[]) {
    return values.join(' ').toLowerCase().includes(search.toLowerCase())
  }

  return (
    <section>
      <div className="engine-toolbar">
        <ComboBox
          className="engine-directory"
          disabled={busy}
          aria-label="查看工作目录"
          value={directory || data?.directory || ''}
          onChange={(event) => {
            setDirectory(event.target.value)
            setSearch('')
          }}
        >
          {data?.directories.map((path) => (
            <option key={path}>{path}</option>
          ))}
        </ComboBox>
        <Button
          disabled={busy}
          onClick={() => {
            setError('')
            void reload().catch((error) => setError(messageOf(error)))
          }}
        >
          刷新
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {section !== 'runtime' && (
            <div className="engine-toolbar">
              <TextBox
                className="engine-search"
                aria-label="搜索设置列表"
                placeholder="搜索"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {section === 'mcp' && (
                <Button variant="primary" onClick={() => setMcp('new')}>
                  添加 MCP
                </Button>
              )}
              {section === 'agents' && (
                <Button variant="primary" onClick={() => setAgent({})}>
                  添加 Agent
                </Button>
              )}
            </div>
          )}
          {section === 'mcp' && (
            <>
              {data.mcp.length === 0 && <p className="muted">尚未配置 MCP。添加本地命令或远程服务。</p>}
              {data.mcp
                .filter((item) => matches(item.id))
                .map((item) => (
                  <article className="engine-row" key={item.id}>
                    <div className="engine-row-body">
                      <strong className="engine-name">{item.id}</strong>
                      <p className="muted engine-description">
                        {item.config?.type === 'remote'
                          ? item.config.url
                          : item.config?.type === 'local'
                            ? item.config.command.join(' ')
                            : '内置或来自其他配置'}
                      </p>
                      {item.status.error && <p className="engine-description">{item.status.error}</p>}
                    </div>
                    <Badge
                      tone={
                        item.status.status === 'failed'
                          ? 'danger'
                          : item.status.status === 'connected'
                            ? 'success'
                            : 'neutral'
                      }
                    >
                      {statusNames[item.status.status] ?? item.status.status}
                    </Badge>
                    <div className="engine-actions">
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            `/opencode/mcp/${item.status.status === 'connected' ? 'disconnect' : 'connect'}`,
                            { id: item.id, directory: data.directory }
                          )
                        }
                      >
                        {item.status.status === 'connected' ? '断开' : '连接'}
                      </Button>
                      {item.editable && (
                        <>
                          <Button size="small" onClick={() => setMcp(item)}>
                            编辑
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            onClick={() => setDeleting({ type: 'mcp', id: item.id })}
                          >
                            删除
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              <p className="muted engine-description">连接操作作用于当前工作目录；编辑和删除保存到全局配置。</p>
            </>
          )}
          {section === 'skills' && (
            <>
              {data.skills
                .filter((item) => matches(item.id, item.name, item.description))
                .map((item) => (
                  <article className="engine-row" key={item.id}>
                    <div className="engine-row-body">
                      <strong className="engine-name">{item.name}</strong>
                      <p className="muted engine-description engine-skill-description">{item.description || item.id}</p>
                    </div>
                    <Button size="small" onClick={() => setSkill(item)}>
                      查看
                    </Button>
                  </article>
                ))}
              {!data.skills.length && <p className="muted">没有发现 Skills，可在运行设置中添加目录。</p>}
            </>
          )}
          {section === 'agents' && (
            <>
              {[
                ...new Set([
                  ...data.agents.filter((item) => !item.hidden).map((item) => item.id),
                  ...Object.keys(data.agentOverrides),
                ]),
              ]
                .filter((id) => matches(id, data.agents.find((item) => item.id === id)?.description))
                .map((id) => {
                  const item = data.agents.find((item) => item.id === id)
                  return (
                    <article className="engine-row" key={id}>
                      <div className="engine-row-body">
                        <strong className="engine-name">{item?.name || id}</strong>
                        <p className="muted engine-description">
                          {item?.description || data.agentOverrides[id]?.description || id}
                        </p>
                      </div>
                      <Badge>
                        {item
                          ? item.mode === 'subagent'
                            ? '子 Agent'
                            : item.mode === 'primary'
                              ? '主 Agent'
                              : '通用角色'
                          : '待重启'}
                      </Badge>
                      <div className="engine-actions">
                        <Button
                          size="small"
                          onClick={() =>
                            setAgent({
                              id,
                              config: data.agentOverrides[id] ?? { description: item?.description, mode: item?.mode },
                            })
                          }
                        >
                          配置
                        </Button>
                        {data.agentOverrides[id] && (
                          <Button size="small" variant="ghost" onClick={() => setDeleting({ type: 'agents', id })}>
                            删除配置
                          </Button>
                        )}
                      </div>
                    </article>
                  )
                })}
            </>
          )}
          {section === 'runtime' && (
            <RuntimeSettings
              key={JSON.stringify(data.runtime)}
              data={data}
              catalog={catalog}
              busy={busy}
              save={(value) => perform('/opencode/runtime', value)}
            />
          )}
        </>
      )}
      {mcp && (
        <McpDialog
          value={mcp === 'new' ? undefined : mcp}
          close={() => setMcp(null)}
          saved={async (restart) => {
            setMcp(null)
            setNotice(restart ? '已保存，重启服务后完整生效。' : '已保存。')
            await reload()
          }}
        />
      )}
      {agent && (
        <AgentDialog
          {...agent}
          catalog={catalog}
          close={() => setAgent(null)}
          saved={async () => {
            setAgent(null)
            setNotice('已保存，重启服务后生效。')
            await reload()
            await reloadCatalog()
          }}
        />
      )}
      {skill && (
        <Dialog
          open
          title={skill.name}
          closeLabel="关闭"
          onOpenChange={(open) => {
            if (!open) setSkill(null)
          }}
        >
          <div className="stack">
            <p className="muted engine-description">{skill.location}</p>
            {skill.description && <p className="muted">{skill.description}</p>}
            <TextArea className="engine-preview" aria-label="Skill 内容" readOnly value={skill.content} />
          </div>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          open
          title={`删除 ${deleting.id}`}
          closeLabel="关闭"
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(null)
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() => void perform(`/opencode/${deleting.type}/delete`, { id: deleting.id })}
              >
                删除
              </Button>
            </>
          }
        >
          <p>删除此处保存的配置。来自其他配置源的同名项仍可能存在。</p>
          {error && <Alert tone="danger">{error}</Alert>}
        </Dialog>
      )}
    </section>
  )
}

function RuntimeSettings({
  data,
  catalog,
  busy,
  save,
}: {
  data: EngineSettingsView
  catalog: Catalog | null
  busy: boolean
  save: (value: object) => Promise<void>
}) {
  const model = data.runtime.model
  const [selected, setSelected] = useState(
    typeof model === 'string' ? model : model ? `${model.providerID}/${model.model}` : ''
  )
  const [auto, setAuto] = useState(data.runtime.compaction?.auto ?? data.effectiveRuntime.compaction?.auto ?? true)
  const [keep, setKeep] = useState(data.runtime.compaction?.keep?.tokens?.toString() ?? '')
  const [buffer, setBuffer] = useState(data.runtime.compaction?.buffer?.toString() ?? '')
  const [skills, setSkills] = useState(data.runtime.skills?.join('\n') ?? '')
  return (
    <>
      <form
        className="engine-runtime"
        onSubmit={(event) => {
          event.preventDefault()
          void save({
            model: selected,
            compaction: {
              auto,
              ...(keep ? { keep: { tokens: Number(keep) } } : {}),
              ...(buffer ? { buffer: Number(buffer) } : {}),
            },
            skills: skills
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          })
        }}
      >
        <Field label="默认模型" htmlFor="index-field-1">
          <ComboBox
            id="index-field-1"
            searchable
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">沿用 OpenCode 默认值</option>
            {catalog?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.provider}
              </option>
            ))}
          </ComboBox>
        </Field>
        <Field label="自动压缩上下文" htmlFor="index-field-2">
          <ComboBox
            id="index-field-2"
            value={auto ? 'on' : 'off'}
            onChange={(event) => setAuto(event.target.value === 'on')}
          >
            <option value="on">开启</option>
            <option value="off">关闭</option>
          </ComboBox>
        </Field>
        <div className="form-grid">
          <Field label="保留最近内容 · Tokens" htmlFor="index-field-3">
            <TextBox
              id="index-field-3"
              type="number"
              min={0}
              step={1}
              value={keep}
              placeholder="默认"
              onChange={(event) => setKeep(event.target.value)}
            />
          </Field>
          <Field label="压缩预留空间 · Tokens" htmlFor="index-field-4">
            <TextBox
              id="index-field-4"
              type="number"
              min={0}
              step={1}
              value={buffer}
              placeholder="默认"
              onChange={(event) => setBuffer(event.target.value)}
            />
          </Field>
        </div>
        <Field label="额外 Skills 路径或 URL · 每行一项" htmlFor="index-field-5">
          <TextArea id="index-field-5" rows={4} value={skills} onChange={(event) => setSkills(event.target.value)} />
        </Field>
        <div className="button-row">
          <Button type="submit" variant="primary" loading={busy}>
            保存运行设置
          </Button>
          <span className="muted">重启服务后生效</span>
        </div>
      </form>
      <details className="engine-details">
        <summary>插件状态 · {data.plugins.length}</summary>
        {data.plugins.map((plugin, index) => (
          <div className="engine-row" key={plugin.id ?? index}>
            <div className="engine-row-body">
              <span className="engine-name">{plugin.id || '未命名插件'}</span>
              {plugin.state.status === 'failed' && <p className="engine-description">{plugin.state.error}</p>}
            </div>
            <Badge tone={plugin.state.status === 'failed' ? 'danger' : 'neutral'}>
              {statusNames[plugin.state.status] ?? plugin.state.status}
            </Badge>
          </div>
        ))}
      </details>
    </>
  )
}

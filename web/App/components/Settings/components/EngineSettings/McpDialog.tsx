import { useState } from 'react'

import { Alert, Button, ComboBox, Dialog, Field, TextArea, TextBox } from '@a1knla/cakeui'

import type { McpConfig, McpView } from '../../../../../../src/opencode-settings'
import { api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

function stringMap(text: string) {
  const value = JSON.parse(text || '{}') as Record<string, unknown>
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new Error('环境变量和请求头需要填写 JSON 字符串键值对象。')
  }
  return value as Record<string, string>
}

export function McpDialog({
  value,
  close,
  saved,
}: {
  value?: McpView
  close: () => void
  saved: (restart: boolean) => Promise<void>
}) {
  const initial = value?.config
  const [baseConfig, setBaseConfig] = useState(initial)
  const [id, setId] = useState(value?.id ?? '')
  const [type, setType] = useState(initial?.type ?? 'local')
  const [command, setCommand] = useState(initial?.type === 'local' ? (initial.command[0] ?? '') : '')
  const [args, setArgs] = useState(initial?.type === 'local' ? initial.command.slice(1).join('\n') : '')
  const [url, setUrl] = useState(initial?.type === 'remote' ? initial.url : '')
  const [cwd, setCwd] = useState(initial?.type === 'local' ? (initial.cwd ?? '') : '')
  const [extra, setExtra] = useState(
    JSON.stringify(initial?.type === 'local' ? (initial.environment ?? {}) : (initial?.headers ?? {}), null, 2)
  )
  const [disabled, setDisabled] = useState(initial?.disabled ?? false)
  const [paste, setPaste] = useState('')
  const [imports, setImports] = useState<Record<string, Record<string, unknown>>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function loadImported(name: string, config: Record<string, unknown>) {
    setId(name)
    const remote = typeof config.url === 'string'
    setType(remote ? 'remote' : 'local')
    setUrl(remote ? String(config.url) : '')
    const parts = Array.isArray(config.command)
      ? config.command
      : [config.command, ...(Array.isArray(config.args) ? config.args : [])]
    setCommand(String(parts[0] ?? ''))
    setArgs(parts.slice(1).join('\n'))
    setExtra(JSON.stringify(remote ? (config.headers ?? {}) : (config.environment ?? config.env ?? {}), null, 2))
    setDisabled(config.disabled === true || config.enabled === false)
    setCwd(typeof config.cwd === 'string' ? config.cwd : '')
    const { args: _args, env: _env, enabled: _enabled, ...native } = config
    setBaseConfig({ ...native, type: remote ? 'remote' : 'local' } as McpConfig)
  }

  function parsePaste() {
    try {
      const json = JSON.parse(paste)
      const servers = json.mcpServers ?? json.mcp?.servers ?? json
      if (
        !servers ||
        typeof servers !== 'object' ||
        Array.isArray(servers) ||
        !Object.keys(servers).length ||
        Object.values(servers).some((item) => !item || typeof item !== 'object' || Array.isArray(item))
      )
        throw new Error()
      setImports(servers)
      const name = Object.keys(servers)[0]!
      loadImported(name, servers[name])
      setError('')
    } catch {
      setError('请粘贴 mcpServers 或 mcp.servers 格式的 JSON 配置。')
    }
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      const common = { ...(baseConfig?.type === type ? baseConfig : {}), disabled }
      const config: McpConfig =
        type === 'local'
          ? {
              ...common,
              type: 'local',
              command: [
                command.trim(),
                ...args
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              ],
              environment: stringMap(extra),
              cwd: cwd.trim() || undefined,
            }
          : { ...common, type: 'remote', url: url.trim(), headers: stringMap(extra) }
      const result = await api<{ restartRequired: boolean }>('/opencode/mcp/save', { id, config, create: !value })
      await saved(result.restartRequired)
    } catch (error) {
      setError(error instanceof SyntaxError ? 'JSON 键值配置格式不正确。' : messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      title={value ? '编辑 MCP' : '添加 MCP'}
      closeLabel="关闭"
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" type="submit" form="mcp-form" loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <form
        id="mcp-form"
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {!value && (
          <details className="engine-details">
            <summary>粘贴配置</summary>
            <div className="stack">
              <TextArea
                aria-label="MCP JSON 配置"
                rows={5}
                value={paste}
                onChange={(event) => setPaste(event.target.value)}
              />
              <Button onClick={parsePaste}>读取配置</Button>
              {Object.keys(imports).length > 1 && (
                <Field label="选择服务" htmlFor="McpDialog-field-1">
                  <ComboBox
                    id="McpDialog-field-1"
                    value={id}
                    onChange={(event) => loadImported(event.target.value, imports[event.target.value]!)}
                  >
                    {Object.keys(imports).map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </ComboBox>
                </Field>
              )}
            </div>
          </details>
        )}
        <Field label="ID" htmlFor="mcp-id">
          <TextBox
            id="mcp-id"
            value={id}
            readOnly={Boolean(value)}
            required
            pattern="[a-zA-Z0-9_-]{1,100}"
            onChange={(event) => setId(event.target.value)}
          />
        </Field>
        <Field label="连接方式" htmlFor="McpDialog-field-2">
          <ComboBox
            id="McpDialog-field-2"
            value={type}
            onChange={(event) => {
              setType(event.target.value as 'local' | 'remote')
              setExtra('{}')
            }}
          >
            <option value="local">本地命令 · stdio</option>
            <option value="remote">远程服务 · HTTP</option>
          </ComboBox>
        </Field>
        {type === 'local' ? (
          <>
            <Field label="命令" htmlFor="McpDialog-field-3">
              <TextBox
                id="McpDialog-field-3"
                required
                value={command}
                placeholder="npx"
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field>
            <Field label="参数 · 每行一项" htmlFor="McpDialog-field-4">
              <TextArea
                id="McpDialog-field-4"
                rows={4}
                value={args}
                placeholder={'-y\n@scope/mcp-server'}
                onChange={(event) => setArgs(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <Field label="服务 URL" htmlFor="McpDialog-field-5">
            <TextBox
              id="McpDialog-field-5"
              type="url"
              required
              value={url}
              placeholder="https://example.com/mcp"
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
        )}
        <details className="engine-details">
          <summary>{type === 'local' ? '环境变量' : '请求头'}</summary>
          {type === 'local' && (
            <Field label="进程工作目录" htmlFor="mcp-cwd">
              <TextBox
                id="mcp-cwd"
                value={cwd}
                placeholder="沿用会话工作目录"
                onChange={(event) => setCwd(event.target.value)}
              />
            </Field>
          )}
          <TextArea
            aria-label={type === 'local' ? '环境变量 JSON' : '请求头 JSON'}
            rows={5}
            value={extra}
            onChange={(event) => setExtra(event.target.value)}
          />
        </details>
        <Field label="启动状态" htmlFor="McpDialog-field-6">
          <ComboBox
            id="McpDialog-field-6"
            value={disabled ? 'disabled' : 'enabled'}
            onChange={(event) => setDisabled(event.target.value === 'disabled')}
          >
            <option value="enabled">启用</option>
            <option value="disabled">禁用</option>
          </ComboBox>
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  )
}

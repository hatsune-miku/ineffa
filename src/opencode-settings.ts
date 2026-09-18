import { Schema } from 'effect'
import { type Host, IneffaError } from 'ineffa'
import { type ParseError, applyEdits, modify, parse } from 'jsonc-parser'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { Config } from '@opencode/schema/config'
import type { OpenCode } from '@opencode/sdk'

type Native = OpenCode.Interface
export type McpConfig = Parameters<Native['mcp']['add']>[0]['config']
type Document = typeof Config.Info.Encoded
export type AgentConfig = NonNullable<Document['agents']>[string]
export type RuntimeConfig = Pick<Document, 'model' | 'compaction' | 'skills'>
export type McpView = { id: string; config?: McpConfig; editable: boolean; status: { status: string; error?: string } }
export type EngineSettingsView = {
  directory: string
  directories: string[]
  mcp: McpView[]
  skills: Awaited<ReturnType<Native['skill']['list']>>['data']
  agents: Awaited<ReturnType<Native['agent']['list']>>['data']
  agentOverrides: Record<string, AgentConfig>
  plugins: Awaited<ReturnType<Native['plugin']['list']>>['data']
  runtime: RuntimeConfig
  effectiveRuntime: RuntimeConfig
}

function idOf(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  ) {
    throw new IneffaError('invalid_setting_id', 'ID 仅支持字母、数字、下划线和连字符。')
  }
  return value
}

function validate(config: unknown) {
  try {
    Schema.decodeUnknownSync(Config.Info)(JSON.parse(JSON.stringify(config)))
  } catch {
    // Native validation errors can include credentials from MCP headers or environment.
    throw new IneffaError('invalid_opencode_setting', '配置格式不正确，请检查字段类型和必填项。')
  }
}

function preserveModelVariant(value: Document['model'], previous: Document['model']) {
  if (previous && typeof previous === 'object' && value === `${previous.providerID}/${previous.model}`) {
    return previous
  }
  return value
}

/** Persist only edited paths in the native JSONC document, preserving unrelated settings and comments. */
export class OpenCodeSettings {
  constructor(
    private host: Host,
    private defaultDirectory: string
  ) {}

  private async document() {
    const jsonc = join(this.host.engine.configDirectory, 'opencode.jsonc')
    const path = (await Bun.file(jsonc).exists()) ? jsonc : join(this.host.engine.configDirectory, 'opencode.json')
    const content = (await Bun.file(path).exists()) ? await readFile(path, 'utf8') : '{}\n'
    const errors: ParseError[] = []
    const config = parse(content, errors, { allowTrailingComma: true }) as Document
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new IneffaError('invalid_opencode_config', 'OpenCode 配置文件不是有效的 JSON/JSONC。')
    }
    return { path, content, config }
  }

  directories() {
    return [
      ...new Set(
        [
          this.defaultDirectory,
          ...[...this.host.adapters.values()].map((adapter) => adapter.directory),
          ...this.host.store.bindings().map((binding) => binding.directory),
        ].map((directory) => resolve(directory))
      ),
    ]
  }

  async view(directory: string): Promise<EngineSettingsView> {
    await this.host.engine.ready(directory)
    const location = { directory }
    const native = this.host.engine.native
    const [document, mcp, skills, agents, plugins, entries] = await Promise.all([
      this.document(),
      native.mcp.list({ location }),
      native.skill.list({ location }),
      native.agent.list({ location }),
      native.plugin.list({ location }),
      native.config.get({ location }),
    ])
    const configured = document.config.mcp?.servers ?? {}
    const ids = new Set([...Object.keys(configured), ...mcp.data.map((server) => server.name)])
    const effectiveRuntime: RuntimeConfig = {}
    for (const entry of entries) {
      if (entry.type !== 'document') continue
      for (const key of ['model', 'compaction', 'skills'] as const) {
        if (entry.info[key] !== undefined) Object.assign(effectiveRuntime, { [key]: entry.info[key] })
      }
    }
    return {
      directory,
      directories: this.directories(),
      mcp: [...ids].map((id) => ({
        id,
        config: configured[id],
        editable: Object.hasOwn(configured, id),
        status: mcp.data.find((server) => server.name === id)?.status ?? { status: 'pending' },
      })),
      skills: skills.data,
      agents: agents.data,
      plugins: plugins.data,
      agentOverrides: document.config.agents ?? {},
      runtime: { model: document.config.model, compaction: document.config.compaction, skills: document.config.skills },
      effectiveRuntime,
    }
  }

  private async persist(changes: { path: string[]; value: unknown }[]) {
    const document = await this.document()
    let content = document.content
    for (const change of changes) {
      content = applyEdits(
        content,
        modify(content, change.path, change.value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
      )
    }
    const temporary = `${document.path}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 })
      await rename(temporary, document.path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async saveMcp(data: Record<string, unknown>) {
    const id = idOf(data.id)
    const existing = (await this.document()).config.mcp?.servers?.[id]
    if (id === 'ineffa_browser' && !existing)
      throw new IneffaError('builtin_mcp', '内置浏览器由运行配置管理，可使用连接按钮临时启停。')
    const config = data.config as McpConfig
    validate({ mcp: { servers: { [id]: config } } })
    if (
      !config ||
      (config.type === 'local' && (!config.command.length || config.command.some((part) => !part.trim())))
    ) {
      throw new IneffaError('invalid_mcp_command', '本地 MCP 需要可执行命令，参数不能留空。')
    }
    if (config.type === 'remote') {
      let url: URL
      try {
        url = new URL(config.url)
      } catch {
        throw new IneffaError('invalid_mcp_url', '请输入有效的 HTTP 或 HTTPS 地址。')
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new IneffaError('invalid_mcp_url', '仅支持 HTTP 或 HTTPS 地址。')
    }
    if (data.create && existing) throw new IneffaError('mcp_exists', '此 MCP ID 已存在。', 409)
    if (!existing) {
      for (const directory of this.directories()) {
        const servers = await this.host.engine.native.mcp.list({ location: { directory } })
        if (servers.data.some((server) => server.name === id))
          throw new IneffaError('mcp_exists', '此 MCP ID 已由其他配置源使用。', 409)
      }
    }
    await this.persist([{ path: ['mcp', 'servers', id], value: config }])
    // Native add is a runtime override; the same config is also persisted for restart.
    const results = await Promise.allSettled(
      this.directories().map((directory) =>
        this.host.engine.native.mcp.add({ server: id, config, location: { directory } })
      )
    )
    return { restartRequired: results.some((result) => result.status === 'rejected') }
  }

  async removeMcp(data: Record<string, unknown>) {
    const id = idOf(data.id)
    if (!Object.hasOwn((await this.document()).config.mcp?.servers ?? {}, id))
      throw new IneffaError('mcp_readonly', '此 MCP 来自其他配置源，不能在这里删除。')
    await this.persist([{ path: ['mcp', 'servers', id], value: undefined }])
    const results = await Promise.allSettled(
      this.directories().map((directory) => this.host.engine.native.mcp.remove({ server: id, location: { directory } }))
    )
    return { restartRequired: results.some((result) => result.status === 'rejected') }
  }

  async saveAgent(data: Record<string, unknown>) {
    const id = idOf(data.id)
    if (!data.config || typeof data.config !== 'object' || Array.isArray(data.config)) {
      throw new IneffaError('invalid_agent', 'Agent 配置必须是对象。')
    }
    const config = { ...(data.config as AgentConfig) }
    // Identity/task and permissions have explicit account/session controls in Ineffa.
    if (Object.keys(config).some((key) => !['description', 'model', 'mode', 'steps', 'hidden'].includes(key)))
      throw new IneffaError('invalid_agent', '仅支持描述、模型、角色、步数和隐藏设置。')
    if (config.model === '') delete config.model
    if (config.steps == null) delete config.steps
    if (config.steps !== undefined && config.steps < 1) throw new IneffaError('invalid_agent', '最大步骤必须大于零。')
    validate({ agents: { [id]: config } })
    const previous = (await this.document()).config.agents?.[id]
    config.model = preserveModelVariant(config.model, previous?.model)
    if (data.create) {
      if (previous) throw new IneffaError('agent_exists', '此 Agent ID 已存在。', 409)
      for (const directory of this.directories()) {
        const agents = await this.host.engine.native.agent.list({ location: { directory } })
        if (agents.data.some((agent) => agent.id === id))
          throw new IneffaError('agent_exists', '此 Agent ID 已存在，请使用配置按钮编辑。', 409)
      }
    }
    await this.persist([
      { path: ['agents', id], value: { ...previous, ...config, model: config.model, steps: config.steps } },
    ])
    return { restartRequired: true }
  }

  async removeAgent(data: Record<string, unknown>) {
    const id = idOf(data.id)
    if (
      [...this.host.adapters.values()].some((adapter) => adapter.agent === id) ||
      this.host.store.bindings().some((binding) => binding.agent === id)
    )
      throw new IneffaError('agent_in_use', '此 Agent 正由账号或会话使用，请先切换。', 409)
    await this.persist([{ path: ['agents', id], value: undefined }])
    return { restartRequired: true }
  }

  async saveRuntime(data: Record<string, unknown>) {
    if (data.model === '') data.model = undefined
    if (Object.keys(data).some((key) => !['model', 'compaction', 'skills'].includes(key)))
      throw new IneffaError('invalid_runtime', '存在不支持的运行设置。')
    if (Object.hasOwn(data, 'model')) {
      data.model = preserveModelVariant(data.model as Document['model'], (await this.document()).config.model)
    }
    validate(data)
    const compaction = data.compaction as RuntimeConfig['compaction']
    if ((compaction?.keep?.tokens ?? 0) < 0 || (compaction?.buffer ?? 0) < 0) {
      throw new IneffaError('invalid_compaction', '压缩 Token 数量不能为负数。')
    }
    await this.persist(Object.entries(data).map(([key, value]) => ({ path: [key], value })))
    return { restartRequired: true }
  }
}

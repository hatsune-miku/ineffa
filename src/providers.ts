import { IneffaError, type OpenCodeBridge } from 'ineffa'
import { type ParseError, applyEdits, modify, parse } from 'jsonc-parser'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { OpenCode } from '@opencode/sdk'

type ConfigDocument = Extract<
  Awaited<ReturnType<OpenCode.Interface['config']['get']>>[number],
  { type: 'document' }
>['info']
type ProviderConfig = NonNullable<ConfigDocument['providers']>[string]

export const compatiblePackage = 'aisdk:@ai-sdk/openai-compatible'

export type ProviderView = {
  id: string
  name: string
  baseURL: string
  hasKey: boolean
  models: string[]
}

function identifier(value: unknown, label: string, provider = false): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    /\s/.test(value.trim()) ||
    ['__proto__', 'constructor', 'prototype'].includes(value.trim()) ||
    (provider && !/^[a-zA-Z0-9_-]+$/.test(value.trim()))
  ) {
    throw new IneffaError('invalid_provider_input', `${label}格式不正确。`)
  }
  return value.trim()
}

export function providerBaseURL(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error()
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error()
    }
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new IneffaError(
      'invalid_base_url',
      'Base URL 必须是 HTTP 或 HTTPS 地址，不能包含用户名、密码、查询参数或片段。'
    )
  }
}

function apiKey(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) {
    throw new IneffaError('invalid_api_key', 'API Key 格式不正确。')
  }
  return value.trim()
}

function view(id: string, config: ProviderConfig): ProviderView {
  return {
    id,
    name: config.name ?? id,
    baseURL: String(config.settings?.baseURL ?? ''),
    hasKey: Boolean(config.settings?.apiKey),
    models: Object.keys(config.models ?? {}),
  }
}

/** Edits OpenCode's own config; no second provider registry or inference proxy. */
export class ProviderSettings {
  private saving: Promise<unknown> = Promise.resolve()

  constructor(
    private engine: OpenCodeBridge,
    private assertUnused: (providerId: string, models?: string[]) => Promise<void> = async () => {}
  ) {}

  private async document() {
    const jsonc = join(this.engine.configDirectory, 'opencode.jsonc')
    const path = (await Bun.file(jsonc).exists()) ? jsonc : join(this.engine.configDirectory, 'opencode.json')
    const content = (await Bun.file(path).exists()) ? await readFile(path, 'utf8') : '{}\n'
    const errors: ParseError[] = []
    const config = parse(content, errors, { allowTrailingComma: true }) as ConfigDocument
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new IneffaError('invalid_provider_config', `OpenCode 配置不是有效的 JSON/JSONC：${path}`)
    }
    return { path, content, config }
  }

  async list(): Promise<ProviderView[]> {
    const { config } = await this.document()
    return Object.entries(config.providers ?? {})
      .filter(([, item]) => item.package === compatiblePackage)
      .map(([id, item]) => view(id, item))
  }

  async discover(data: Record<string, unknown>, signal?: AbortSignal) {
    const baseURL = providerBaseURL(data.baseURL)
    let key = apiKey(data.key)
    if (!key && data.id) {
      const id = identifier(data.id, '提供方 ID', true)
      const previous = (await this.document()).config.providers?.[id]
      // A changed endpoint must not receive a saved credential without entering it again.
      if (previous?.settings?.baseURL === baseURL) key = apiKey(previous.settings.apiKey)
      else if (previous?.settings?.apiKey) {
        throw new IneffaError('api_key_required', 'Base URL 已变化，请重新填写 API Key 后获取模型。')
      }
    }
    const timeout = AbortSignal.timeout(15_000)
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
    let response: Response
    try {
      response = await fetch(`${baseURL}/models`, {
        headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        redirect: 'error',
        signal: combined,
      })
    } catch (error) {
      if (timeout.aborted)
        throw new IneffaError('model_discovery_timeout', '获取模型超过 15 秒，请检查 Base URL 或手动填写模型 ID。', 504)
      if (signal?.aborted) throw new IneffaError('model_discovery_cancelled', '已取消获取模型。', 499)
      const reason = error instanceof Error ? error.message.replaceAll(key || '\0', '[已隐藏]') : '网络错误'
      throw new IneffaError('model_discovery_failed', `无法请求模型列表：${reason}。请检查 Base URL。`, 502)
    }
    if (!response.ok) {
      await response.body?.cancel()
      const reason =
        response.status === 404 || response.status === 405
          ? '此地址未提供标准 /models 接口，可手动填写模型 ID。'
          : response.status === 401 || response.status === 403
            ? '请检查 API Key 和访问权限。'
            : '请检查提供方服务状态，或手动填写模型 ID。'
      throw new IneffaError('model_discovery_failed', `获取模型失败，HTTP ${response.status}。${reason}`, 502)
    }
    let result: unknown
    try {
      result = await response.json()
    } catch {
      throw new IneffaError('invalid_model_list', '模型接口没有返回有效 JSON，可手动填写模型 ID。', 502)
    }
    const entries = (result as { data?: unknown } | null)?.data
    if (!Array.isArray(entries)) {
      throw new IneffaError('invalid_model_list', '模型接口应返回包含 data 数组的 OpenAI 兼容格式。', 502)
    }
    const models = new Map<string, { id: string; name: string }>()
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') continue
      try {
        const id = identifier(entry.id, '模型 ID')
        models.set(id, { id, name: typeof entry.name === 'string' ? entry.name.slice(0, 256) : id })
      } catch {
        // A malformed entry must not hide the other valid model IDs.
      }
    }
    return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) }
  }

  save(data: Record<string, unknown>, directory: string) {
    const task = this.saving.catch(() => {}).then(() => this.write(data, directory))
    this.saving = task
    return task
  }

  remove(data: Record<string, unknown>, directory: string) {
    const task = this.saving
      .catch(() => {})
      .then(async () => {
        const id = identifier(data.id, '提供方 ID', true)
        const model = data.model === undefined ? undefined : identifier(data.model, '模型 ID')
        await this.engine.ready(directory)
        const document = await this.document()
        const previous = document.config.providers?.[id]
        if (!previous || previous.package !== compatiblePackage) {
          throw new IneffaError('provider_not_found', '此提供方不是通过界面配置的，请在原配置中修改。', 404)
        }
        if (model !== undefined && !Object.hasOwn(previous.models ?? {}, model)) {
          throw new IneffaError('model_not_found', '此模型配置已不存在。', 404)
        }
        await this.assertUnused(id, model === undefined ? undefined : [model])
        if (model === undefined) {
          return this.persist(id, undefined, document, directory, Object.keys(previous.models ?? {}))
        }
        const models = { ...previous.models }
        delete models[model]
        return this.persist(id, { ...previous, models }, document, directory, [model])
      })
    this.saving = task
    return task
  }

  private async write(data: Record<string, unknown>, directory: string) {
    const id = identifier(data.id, '提供方 ID', true)
    const baseURL = providerBaseURL(data.baseURL)
    const key = apiKey(data.key)
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 128) {
      throw new IneffaError('invalid_provider_name', '请输入不超过 128 字符的提供方名称。')
    }
    if (!Array.isArray(data.models) || !data.models.length || data.models.length > 2000) {
      throw new IneffaError('invalid_provider_models', '请至少选择或填写一个模型，最多 2000 个。')
    }
    const models = [...new Set(data.models.map((item) => identifier(item, '模型 ID')))]
    await this.engine.ready(directory)
    const { path, content, config } = await this.document()
    const previous = config.providers?.[id]
    if (previous && previous.package !== compatiblePackage) {
      throw new IneffaError('provider_conflict', '此 ID 已由其他类型的提供方使用，请使用新的提供方 ID。', 409)
    }
    if (!previous) {
      const integrations = await this.engine.native.integration.list({ location: { directory } })
      if (integrations.data.some((item) => item.id === id)) {
        throw new IneffaError('provider_conflict', '此 ID 已存在于 OpenCode 中，请使用新的提供方 ID。', 409)
      }
    }
    if (previous?.settings?.apiKey && previous.settings.baseURL !== baseURL && !key) {
      throw new IneffaError('api_key_required', 'Base URL 已变化，请重新填写 API Key 后保存。')
    }
    const removed = Object.keys(previous?.models ?? {}).filter((model) => !models.includes(model))
    if (removed.length) await this.assertUnused(id, removed)
    const provider: ProviderConfig = {
      ...previous,
      name: data.name.trim(),
      package: compatiblePackage,
      settings: { ...previous?.settings, baseURL, apiKey: key || previous?.settings?.apiKey || '' },
      models: Object.fromEntries(models.map((model) => [model, previous?.models?.[model] ?? { name: model }])),
    }
    return this.persist(id, provider, { path, content, config }, directory, removed)
  }

  private async persist(
    id: string,
    provider: ProviderConfig | undefined,
    document: Awaited<ReturnType<ProviderSettings['document']>>,
    directory: string,
    removed: string[]
  ) {
    const { path, content } = document
    const updated = applyEdits(
      content,
      modify(content, ['providers', id], provider, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      })
    )
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, updated.endsWith('\n') ? updated : `${updated}\n`, { mode: 0o600 })
    await rename(temporary, path)

    // OpenCode watches its config and reloads catalogs without interrupting a generation.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const entries = await this.engine.native.config.get({ location: { directory } })
      const loaded = entries.some(
        (entry) =>
          entry.type === 'document' &&
          entry.path === path &&
          JSON.stringify(entry.info.providers?.[id]) === JSON.stringify(provider)
      )
      if (loaded) {
        const available = await this.engine.native.model.list({ location: { directory } })
        const current = available.data.filter((item) => item.providerID === id).map((item) => item.id)
        if (
          Object.keys(provider?.models ?? {}).every((model) => current.includes(model)) &&
          removed.every((model) => !current.includes(model))
        ) {
          return { provider: provider ? view(id, provider) : null, restartRequired: false }
        }
      }
      await Bun.sleep(100)
    }
    return { provider: provider ? view(id, provider) : null, restartRequired: true }
  }
}

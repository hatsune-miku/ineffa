import { type Adapter, IneffaError, type OpenCodeOptions, modelReference, validateAgentPrompt } from 'ineffa'
import { type KookOptions, kook } from 'ineffa-kook'
import { type LarkOptions, lark } from 'ineffa-lark'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface AppConfig {
  directory?: string
  dataDirectory?: string
  adapters?: Adapter[]
  opencode?: OpenCodeOptions
  limits?: Partial<{ maxPending: number }>
}
export type AccountConfig =
  | (KookOptions & {
      platform?: 'kook'
      appId?: never
      appSecret?: never
      domain?: never
      chats?: never
    })
  | (LarkOptions & { platform: 'lark'; token?: never; guilds?: never; channels?: never })

export function accountAdapter(config: AccountConfig): Adapter {
  return config.platform === 'lark' ? lark(config) : kook(config)
}
export async function readConfig(): Promise<AppConfig> {
  const path = resolve(process.env.INEFFA_CONFIG ?? 'ineffa.config.ts')
  if (!(await Bun.file(path).exists())) return {}
  const config = (await import(pathToFileURL(path).href)).default
  if (!config || typeof config !== 'object') throw new Error('ineffa.config.ts 必须默认导出配置对象。')
  return config as AppConfig
}
export class AccountsConfig {
  private accounts: AccountConfig[] = []
  private saving: Promise<unknown> = Promise.resolve()
  constructor(readonly path: string) {}
  list() {
    return structuredClone(this.accounts)
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(data)) throw new Error('账号配置必须是数组。')
      this.accounts = data.map(validateAccount)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return this.accounts
  }
  get(id: string) {
    return this.accounts.find((account) => account.id === id)
  }
  add(value: AccountConfig) {
    const next = this.saving.catch(() => {}).then(() => this.save(value, false))
    this.saving = next
    return next
  }
  update(value: AccountConfig) {
    const next = this.saving.catch(() => {}).then(() => this.save(value, true))
    this.saving = next
    return next
  }
  private async save(value: AccountConfig, replace: boolean) {
    if (!replace && this.get(value.id)) throw new IneffaError('duplicate_adapter', '此账号 ID 已存在。', 409)
    if (replace && !this.get(value.id))
      throw new IneffaError('account_readonly', '请在 ineffa.config.ts 中修改此账号。', 409)
    const next = replace ? this.accounts.map((a) => (a.id === value.id ? value : a)) : [...this.accounts, value]
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, this.path)
    this.accounts = next
  }
}
export function validateAccount(value: {
  token: string
  platform?: 'kook'
  [key: string]: unknown
}): Extract<AccountConfig, { platform?: 'kook' }>
export function validateAccount(value: {
  platform: 'lark'
  [key: string]: unknown
}): Extract<AccountConfig, { platform: 'lark' }>
export function validateAccount(value: unknown): AccountConfig
export function validateAccount(value: unknown): AccountConfig {
  if (!value || typeof value !== 'object') throw new IneffaError('invalid_account', '账号配置格式不正确。')
  const data = value as Record<string, unknown>
  if (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.id) || data.id === 'web')
    throw new IneffaError('invalid_account_id', '请使用 1–64 位字母、数字、下划线或连字符作为账号 ID。')
  const platform = data.platform ?? 'kook'
  if (platform !== 'kook' && platform !== 'lark') throw new IneffaError('invalid_platform', '不支持此平台。')
  const backend = data.backend ?? 'opencode'
  if (backend !== 'opencode' && backend !== 'pi') throw new IneffaError('invalid_backend', '不支持此后端。')
  if (typeof data.directory !== 'string' || !data.directory.trim())
    throw new IneffaError('missing_directory', '请输入 Agent 工作目录。')
  function ids(field: string, pattern = /^\d+$/) {
    const values = data[field] ?? []
    if (!Array.isArray(values) || values.some((id) => typeof id !== 'string' || !pattern.test(id)))
      throw new IneffaError(
        'invalid_access_list',
        platform === 'kook' ? '服务器、频道和私聊用户列表必须使用平台数字 ID。' : '访问列表包含无效的平台 ID。'
      )
    return values as string[]
  }
  const model = modelReference(data.model)
  const common = {
    id: data.id,
    backend,
    directory: resolve(data.directory),
    name: typeof data.name === 'string' ? data.name : undefined,
    agent: typeof data.agent === 'string' ? data.agent : 'build',
    model: model ? `${model.providerID}/${model.id}` : undefined,
    agentPrompt: validateAgentPrompt(data.agentPrompt),
  }
  if (backend === 'pi' && !model) throw new IneffaError('missing_model', '请为 Pi 账号绑定模型。')
  if (platform === 'lark') {
    if (typeof data.appId !== 'string' || !/^cli_[a-fA-F0-9]{16}$/.test(data.appId.trim()))
      throw new IneffaError('invalid_app_id', '请输入有效的 App ID。')
    if (typeof data.appSecret !== 'string' || !data.appSecret.trim())
      throw new IneffaError('missing_app_secret', '请输入 App Secret。')
    if (data.domain !== undefined && data.domain !== 'feishu' && data.domain !== 'lark')
      throw new IneffaError('invalid_domain', '请选择飞书或 Lark。')
    return {
      ...common,
      backend,
      platform,
      appId: data.appId.trim(),
      appSecret: data.appSecret.trim(),
      domain: data.domain === 'lark' ? 'lark' : 'feishu',
      chats: ids('chats', /^oc_[\w-]+$/),
      users: ids('users', /^ou_[\w-]+$/),
    }
  }
  if (typeof data.token !== 'string' || !data.token.trim())
    throw new IneffaError('missing_token', '请输入 KOOK Token。')
  return {
    ...common,
    backend,
    platform,
    token: data.token.trim(),
    guilds: ids('guilds'),
    channels: ids('channels'),
    users: ids('users'),
  }
}
export async function prepareDirectories(config: AppConfig) {
  const dataDirectory = resolve(process.env.INEFFA_DATA_DIR ?? config.dataDirectory ?? '.ineffa')
  const directory = resolve(config.directory ?? 'workspace')
  await Promise.all([mkdir(dataDirectory, { recursive: true }), mkdir(directory, { recursive: true })])
  return { dataDirectory, directory }
}

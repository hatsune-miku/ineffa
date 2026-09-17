import { Database } from 'bun:sqlite'
import { type Host, IneffaError } from 'ineffa'
import { type ParseError, parse } from 'jsonc-parser'
import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Config } from '@opencode/sdk'

import { AccountsConfig, validateAccount } from './config'

type ObjectData = Record<string, unknown>
type Credential = { label: string; value: ObjectData; active: boolean }
export type ConfigArchive = {
  format: 'ineffa-config'
  version: 1
  exportedAt: string
  accounts: ReturnType<AccountsConfig['list']>
  opencode: ObjectData
  credentials: Record<string, Credential[]>
}
export type MergeChoice = { key: string; action: 'keep' | 'import'; directory?: string }
export type MergeItem = {
  key: string
  kind: 'account' | 'provider' | 'setting' | 'credential'
  id: string
  name: string
  conflict: boolean
  identical: boolean
  blocked?: string
  local: string
  incoming: string
  directory?: string
  sourceDirectory?: string
}
export type MergePreview = { revision: string; items: MergeItem[]; notices: string[] }
type PendingImport = {
  version: 1
  accounts: ConfigArchive['accounts']
  opencode: ObjectData
  credentials: ConfigArchive['credentials']
}

function object(value: unknown): ObjectData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IneffaError('invalid_archive', '配置文件结构不正确。')
  }
  return value as ObjectData
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function validateTree(value: unknown, depth = 0) {
  if (depth > 40) throw new IneffaError('invalid_archive', '配置嵌套过深。')
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new IneffaError('invalid_archive', '配置含有不支持的字段名。')
    }
    validateTree(item, depth + 1)
  }
}

function validateOpenCode(value: unknown): ObjectData {
  const data = object(value)
  try {
    new Config.Info(data as ConstructorParameters<typeof Config.Info>[0])
  } catch {
    // Schema errors can contain API keys. Never return their raw text to the browser.
    throw new IneffaError('invalid_archive', 'OpenCode 配置字段或类型不正确。')
  }
  return data
}

export function parseArchive(value: unknown): ConfigArchive {
  validateTree(value)
  const data = object(value)
  if (data.format !== 'ineffa-config' || data.version !== 1) {
    throw new IneffaError('invalid_archive', '不支持的配置文件格式或版本。')
  }
  if (!Array.isArray(data.accounts) || data.accounts.length > 1000) {
    throw new IneffaError('invalid_archive', '平台账号列表不正确。')
  }
  const accounts = data.accounts.map((account) => {
    const source = object(account)
    const result = validateAccount(source)
    // Keep the source path intact until the wizard chooses a target directory.
    return { ...result, directory: source.directory as string }
  })
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
    throw new IneffaError('invalid_archive', '配置文件存在重复账号 ID。')
  }
  const credentials = object(data.credentials) as ConfigArchive['credentials']
  for (const [id, entries] of Object.entries(credentials)) {
    if (
      !id ||
      !Array.isArray(entries) ||
      entries.length > 1000 ||
      entries.filter((entry) => entry?.active).length > 1
    ) {
      throw new IneffaError('invalid_archive', '提供方凭据列表不正确。')
    }
    for (const entry of entries) {
      object(entry)
      const value = object(entry.value)
      if (
        typeof entry.label !== 'string' ||
        typeof entry.active !== 'boolean' ||
        (value.type !== 'key' && value.type !== 'oauth') ||
        (value.type === 'key' && typeof value.key !== 'string') ||
        (value.type === 'oauth' &&
          (typeof value.access !== 'string' ||
            typeof value.refresh !== 'string' ||
            typeof value.methodID !== 'string' ||
            !Number.isFinite(value.expires)))
      ) {
        throw new IneffaError('invalid_archive', '提供方凭据格式不正确。')
      }
    }
  }
  return {
    format: 'ineffa-config',
    version: 1,
    exportedAt: String(data.exportedAt ?? ''),
    accounts,
    opencode: validateOpenCode(data.opencode),
    credentials,
  }
}

async function configDocument(directory: string) {
  const jsonc = join(directory, 'opencode.jsonc')
  const path = (await Bun.file(jsonc).exists()) ? jsonc : join(directory, 'opencode.json')
  const errors: ParseError[] = []
  const config = parse((await Bun.file(path).exists()) ? await readFile(path, 'utf8') : '{}', errors)
  if (errors.length) throw new IneffaError('invalid_config', '当前 OpenCode 配置无法解析。')
  return { path, config: validateOpenCode(config) }
}

function readCredentials(path: string): ConfigArchive['credentials'] {
  const db = new Database(path, { readonly: true })
  try {
    const rows = db
      .query<{ integration_id: string; label: string; value: string; active: number }, []>(
        'SELECT integration_id, label, value, active FROM credential WHERE integration_id IS NOT NULL ORDER BY time_created, id'
      )
      .all()
    const groups: ConfigArchive['credentials'] = Object.create(null)
    for (const row of rows) {
      ;(groups[row.integration_id] ??= []).push({
        label: row.label,
        value: JSON.parse(row.value),
        active: row.active === 1,
      })
    }
    return groups
  } finally {
    db.close()
  }
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function pendingImportPath(accountsPath: string) {
  return join(dirname(accountsPath), 'config-import.pending.json')
}

/** Applied under the process ownership lock, before OpenCode or any adapter starts. */
export async function applyPendingImport(accountsPath: string, configDirectory: string, databasePath: string) {
  const pendingPath = pendingImportPath(accountsPath)
  if (!(await Bun.file(pendingPath).exists())) return
  const pending = (await Bun.file(pendingPath).json()) as PendingImport
  const archive = parseArchive({ ...pending, format: 'ineffa-config' })
  const document = await configDocument(configDirectory)
  const db = new Database(databasePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    for (const [id, credentials] of Object.entries(archive.credentials)) {
      db.query('DELETE FROM credential WHERE integration_id = ?').run(id)
      for (const entry of credentials) {
        db.query(
          'INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          `cred_${crypto.randomUUID()}`,
          id,
          entry.label,
          JSON.stringify(entry.value),
          Number(entry.active),
          Date.now(),
          Date.now()
        )
      }
    }
    await atomicJson(document.path, archive.opencode)
    await atomicJson(accountsPath, archive.accounts.map(validateAccount))
    db.exec('COMMIT')
    await rm(pendingPath)
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    // Keep the pending file: a failed/crashed startup replays it before any service can start.
    throw error
  } finally {
    db.close()
  }
}

export class ConfigTransfer {
  private saving: Promise<unknown> = Promise.resolve()
  constructor(
    private host: Host,
    private accounts: AccountsConfig,
    private directory: string
  ) {}

  async pending() {
    return Bun.file(pendingImportPath(this.accounts.path)).exists()
  }

  async cancel() {
    await this.saving.catch(() => {})
    await rm(pendingImportPath(this.accounts.path), { force: true })
  }

  async export(): Promise<ConfigArchive> {
    return {
      format: 'ineffa-config',
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: this.accounts.list(),
      opencode: (await configDocument(this.host.engine.configDirectory)).config,
      credentials: readCredentials(this.host.engine.databasePath),
    }
  }

  async preview(value: unknown): Promise<MergePreview> {
    const incoming = parseArchive(value)
    const current = await this.export()
    const items: MergeItem[] = []
    function add(kind: MergeItem['kind'], id: string, local: unknown, value: unknown, name = id) {
      const item: MergeItem = {
        key: `${kind}:${id}`,
        kind,
        id,
        name,
        conflict: local !== undefined,
        identical: local !== undefined && stable(local) === stable(value),
        local: '',
        incoming: '',
      }
      items.push(item)
      return item
    }
    for (const account of incoming.accounts) {
      const previous = this.accounts.get(account.id)
      const item = add('account', account.id, previous, account, account.name || account.id)
      item.local = previous ? `${previous.name || previous.id} · ${previous.model || '默认模型'}` : ''
      item.incoming = `${account.model || '默认模型'} · ${account.agent}`
      item.sourceDirectory = account.directory
      item.directory = previous?.directory ?? this.directory
      if (!previous && this.host.adapters.has(account.id)) item.blocked = '此 ID 由配置文件管理'
    }
    for (const [id, provider] of Object.entries(object(incoming.opencode.providers ?? {}))) {
      const previous = object(current.opencode.providers ?? {})[id]
      const data = object(provider)
      const item = add('provider', id, previous, provider, typeof data.name === 'string' ? data.name : id)
      function description(value: unknown) {
        if (!value) return ''
        const p = object(value)
        return `${String(object(p.settings ?? {}).baseURL ?? p.package ?? '')} · ${Object.keys(object(p.models ?? {})).join(', ')}`
      }
      item.local = description(previous)
      item.incoming = description(provider)
    }
    for (const [key, setting] of Object.entries(incoming.opencode)) {
      if (key !== 'providers') {
        const item = add('setting', key, current.opencode[key], setting)
        // Scalar settings can be compared directly; structured settings expose field names only.
        function description(value: unknown) {
          if (value === undefined) return ''
          if (typeof value === 'string' && ['model', 'default_agent', 'shell', 'share', 'update'].includes(key))
            return value
          if (typeof value === 'number' || typeof value === 'boolean') return String(value)
          if (Array.isArray(value)) return `${value.length} 项`
          if (value && typeof value === 'object') return Object.keys(value).join(', ')
          return '已设置'
        }
        item.local = description(current.opencode[key])
        item.incoming = description(setting)
      }
    }
    for (const [id, entries] of Object.entries(incoming.credentials)) {
      const item = add('credential', id, current.credentials[id], entries)
      item.local = current.credentials[id] ? `${current.credentials[id].length} 组凭据` : ''
      item.incoming = `${entries.length} 组凭据`
    }
    const notices = [
      '明文文件包含 API Key 和 Bot Token。',
      '只合并配置，不导入会话与工作文件；重启服务后生效。',
      '环境变量、代码配置与 Skills 文件需在目标机器另行配置。',
    ]
    if ([...this.host.adapters.values()].some((a) => a.platform !== 'web' && !this.accounts.get(a.id))) {
      notices.push('代码创建的 Adapter 需在原配置文件中迁移。')
    }
    return {
      revision: createHash('sha256')
        .update(stable({ ...current, exportedAt: '' }))
        .digest('hex'),
      items,
      notices,
    }
  }

  stage(value: unknown, revision: unknown, choices: unknown) {
    const task = this.saving
      .catch(() => {})
      .then(async () => {
        if (await this.pending()) throw new IneffaError('import_pending', '已有待生效的导入，请先重启服务。', 409)
        const archive = parseArchive(value)
        const preview = await this.preview(archive)
        if (revision !== preview.revision)
          throw new IneffaError('config_changed', '配置已变化，请重新预览并确认合并。', 409)
        if (!Array.isArray(choices) || choices.length !== preview.items.length) {
          throw new IneffaError('invalid_choices', '请为每项配置选择合并方式。')
        }
        const selected = new Map<string, MergeChoice>()
        for (const choice of choices) {
          const data = object(choice)
          if (
            typeof data.key !== 'string' ||
            !['keep', 'import'].includes(String(data.action)) ||
            selected.has(data.key)
          ) {
            throw new IneffaError('invalid_choices', '合并选项不正确。')
          }
          selected.set(data.key, data as MergeChoice)
        }
        const current = await this.export()
        const pending: PendingImport = {
          version: 1,
          accounts: current.accounts,
          opencode: current.opencode,
          credentials: {},
        }
        let count = 0
        for (const item of preview.items) {
          const choice = selected.get(item.key)
          if (!choice) throw new IneffaError('invalid_choices', '缺少合并选项。')
          if (choice.action === 'keep') continue
          if (item.blocked) throw new IneffaError('account_readonly', item.blocked, 409)
          count++
          if (item.kind === 'account') {
            const source = archive.accounts.find((a) => a.id === item.id)!
            const account = validateAccount({ ...source, directory: choice.directory })
            const previous = this.accounts.get(item.id)
            if (
              previous &&
              this.host.store.bindings().some((b) => b.adapterId === item.id) &&
              (account.directory !== previous.directory || account.agent !== previous.agent)
            ) {
              throw new IneffaError(
                'account_in_use',
                `账号「${item.name}」还有活跃会话，请保留原工作目录和 Agent，或先归档会话。`,
                409
              )
            }
            pending.accounts = [...pending.accounts.filter((a) => a.id !== item.id), account]
          } else if (item.kind === 'provider') {
            const providers = object(pending.opencode.providers ?? {})
            const incoming = object(archive.opencode.providers)[item.id]
            // Preserve models that exist only locally, including models used by existing sessions.
            const old = object(providers[item.id] ?? {})
            const next = object(incoming)
            providers[item.id] = { ...next, models: { ...object(old.models ?? {}), ...object(next.models ?? {}) } }
            pending.opencode.providers = providers
          } else if (item.kind === 'setting') pending.opencode[item.id] = archive.opencode[item.id]
          else pending.credentials[item.id] = archive.credentials[item.id]!
        }
        if (!count) throw new IneffaError('empty_import', '尚未选择要导入的配置。')
        const incomingProviders = object(archive.opencode.providers ?? {})
        const mergedProviders = object(pending.opencode.providers ?? {})
        for (const account of pending.accounts) {
          if (selected.get(`account:${account.id}`)?.action !== 'import' || !account.model) continue
          const slash = account.model.indexOf('/')
          const provider = account.model.slice(0, slash)
          const model = account.model.slice(slash + 1)
          if (Object.hasOwn(incomingProviders, provider)) {
            const models = object(object(mergedProviders[provider] ?? {}).models ?? {})
            if (!Object.hasOwn(models, model)) {
              throw new IneffaError(
                'missing_import_model',
                `账号「${account.name || account.id}」需要模型 ${account.model}，请同时导入对应提供方。`
              )
            }
          }
        }
        validateOpenCode(pending.opencode)
        await atomicJson(pendingImportPath(this.accounts.path), pending)
        return { count, restartRequired: true }
      })
    this.saving = task
    return task
  }
}

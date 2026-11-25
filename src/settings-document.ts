import { IneffaError } from 'ineffa'
import { type ParseError, parse } from 'jsonc-parser'
import { join } from 'node:path'

import type { OpenCode } from '@opencode/sdk'

export type ConfigDocument = Extract<
  Awaited<ReturnType<OpenCode.Interface['config']['get']>>[number],
  { type: 'document' }
>['info']

/** The global settings file edited by the Web UI and shared by both backends. */
export async function readSettingsDocument(directory: string, errorCode = 'invalid_opencode_config') {
  const jsonc = join(directory, 'opencode.jsonc')
  const path = (await Bun.file(jsonc).exists()) ? jsonc : join(directory, 'opencode.json')
  const file = Bun.file(path)
  const content = (await file.exists()) ? await file.text() : '{}\n'
  const errors: ParseError[] = []
  const config = parse(content, errors, { allowTrailingComma: true }) as ConfigDocument
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
    throw new IneffaError(errorCode, 'OpenCode 配置文件不是有效的 JSON/JSONC。')
  }
  return { path, content, config }
}

import { type PiResourcesConfig } from 'ineffa'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { readSettingsDocument } from './settings-document'

/** Only the explicitly configured global resources are shared with Pi. */
export async function readPiResources(
  configDirectory: string,
  workspace: string,
  browser: boolean
): Promise<PiResourcesConfig> {
  const { config } = await readSettingsDocument(configDirectory)
  const mcp: NonNullable<PiResourcesConfig['mcp']> = Object.create(null)
  for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
    const executionMs = server.timeout?.execution ?? config.mcp?.timeout?.execution
    const options = {
      enabled: !server.disabled,
      timeout: executionMs && executionMs > 0 ? executionMs / 1000 : undefined,
    }
    if (server.type === 'local') {
      const [command, ...args] = server.command
      if (!command) continue
      mcp[name] = {
        ...options,
        command,
        args,
        env: server.environment,
        cwd: resolve(workspace, server.cwd ?? '.'),
      }
    } else {
      mcp[name] = { ...options, url: server.url, headers: server.headers }
    }
  }
  const skills = (config.skills ?? [])
    .filter((path) => !/^https?:\/\//i.test(path))
    .map((path) => (path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(workspace, path)))
  return { mcp, skills, browser }
}

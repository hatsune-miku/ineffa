import { join } from 'node:path'

import {
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
  type McpServerConfig,
  createMcpExtension,
  loadSkills,
} from '@earendil-works/pi-coding-agent'

import { browserCommand, browserServer } from './browser'
import { type DirectoryGroup as PiToolGroup, directoryTools as piDirectories } from './directories'

export { directoryTools as piDirectories } from './directories'

export type PiResourcesConfig = {
  /** Explicit files/directories only; Pi's global and project defaults are not inherited. */
  skills?: string[]
  mcp?: Record<string, McpServerConfig>
  browser?: boolean
}

const codingTools = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'])

/** Native Pi owns MCP connections, tool execution and skill discovery. This only selects resources. */
export class PiResources {
  private api?: ExtensionAPI
  private connecting = new Map<string, Promise<void>>()
  private complete = new Map<string, () => void>()
  private failures = new Map<string, string>()
  private signature: string
  private config: PiResourcesConfig
  private loadedSkills: ReturnType<typeof loadSkills> = { skills: [], diagnostics: [] }

  constructor(
    private directory: string,
    private agentDirectory: string,
    config: PiResourcesConfig = {}
  ) {
    this.config = config
    this.signature = JSON.stringify(config)
  }

  update(config: PiResourcesConfig) {
    const signature = JSON.stringify(config)
    if (signature === this.signature) return false
    this.signature = signature
    this.config = config
    return true
  }

  skills() {
    return this.loadedSkills
  }

  reloadSkills() {
    this.loadedSkills = loadSkills({
      cwd: this.directory,
      agentDir: this.agentDirectory,
      skillPaths: this.config.skills ?? [],
      includeDefaults: false,
    })
    return this.loadedSkills
  }

  private servers() {
    const entries = { ...this.config.mcp }
    if (this.config.browser && !entries[browserServer]) {
      const [command, ...args] = browserCommand()
      entries[browserServer] = { command: command!, args }
    }
    return Object.entries(entries).filter(
      ([, config]) =>
        config.enabled !== false &&
        (config.exposure !== 'hidden' ||
          Object.values(config.toolExposure ?? {}).some((exposure) => exposure !== 'hidden'))
    )
  }

  serverCount(group: PiToolGroup) {
    return this.servers().filter(([name]) => (name === browserServer ? 'browser' : 'generic') === group).length
  }

  group(name: string): PiToolGroup {
    if (name.startsWith(`mcp__${browserServer}__`)) return 'browser'
    return codingTools.has(name) ? 'coding' : 'generic'
  }

  names(session: AgentSession, group: PiToolGroup, files: boolean) {
    if (group === 'skills') return this.skills().skills.some((skill) => !skill.disableModelInvocation) ? ['read'] : []
    return session
      .getAllTools()
      .filter((tool) => tool.exposure !== 'hidden' && !Object.hasOwn(piDirectories, tool.name))
      .filter((tool) => tool.name !== 'send_file' || files)
      .filter((tool) => this.group(tool.name) === group)
      .map((tool) => tool.name)
  }

  extensions(): ExtensionFactory[] {
    return [
      createMcpExtension({
        // Registration happens only when a directory is opened, not at ordinary session startup.
        loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
        logPath: join(this.agentDirectory, 'mcp.log'),
      }),
      (pi) => {
        this.api = pi
        this.connecting.clear()
        this.complete.clear()
        this.failures.clear()
        // The native MCP handler precedes this handler and awaits connection/tool registration.
        pi.on('mcp_servers_change', (event) => {
          for (const { name } of event.servers) this.complete.get(name)?.()
        })
        pi.on('session_shutdown', () => {
          for (const finish of this.complete.values()) finish()
          this.complete.clear()
        })
      },
    ]
  }

  async connect(group: PiToolGroup, signal?: AbortSignal, retry = true) {
    signal?.throwIfAborted()
    const api = this.api
    if (!api) throw new Error('Pi resource extension is not ready.')
    const servers = this.servers().filter(([name]) => (name === browserServer ? 'browser' : 'generic') === group)
    const pending = Promise.all(
      servers.map(async ([name, config]) => {
        if (!retry && this.failures.has(name)) return
        let task = this.connecting.get(name)
        if (!task) {
          const ready = new Promise<void>((resolve, reject) => {
            this.complete.set(name, resolve)
            try {
              api.registerMcpServer(name, {
                ...config,
                exposure: config.exposure === 'hidden' ? 'hidden' : 'deferred',
                toolExposure: Object.fromEntries(
                  Object.entries(config.toolExposure ?? {}).map(([tool, exposure]) => [
                    tool,
                    exposure === 'hidden' ? 'hidden' : 'deferred',
                  ])
                ),
              })
            } catch (error) {
              reject(error)
            }
          })
          task = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                ready,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('MCP discovery timed out.')),
                    (config.timeout ?? 60) * 1000 + 1000
                  )
                }),
              ])
              const namespace = 'mcp__' + name.replaceAll('-', '_')
              const tools = api.getAllTools().filter((tool) => tool.exposure !== 'hidden')
              if (!tools.some((tool) => tool.namespace?.name === namespace || tool.name === 'list_mcp_resources')) {
                throw new Error('MCP did not provide any accessible tools or resources.')
              }
              this.failures.delete(name)
            } finally {
              if (timer) clearTimeout(timer)
              this.complete.delete(name)
            }
          })()
          this.connecting.set(name, task)
        }
        try {
          await task
        } catch (error) {
          this.failures.set(name, error instanceof Error ? error.message : String(error))
          this.connecting.delete(name)
          api.unregisterMcpServer(name)
        }
      })
    )
    let abort: (() => void) | undefined
    try {
      signal?.throwIfAborted()
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal?.reason ?? new Error('Tool discovery was interrupted.'))
          signal?.addEventListener('abort', abort, { once: true })
        }),
      ])
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
    }
    return servers.flatMap(([name]) => (this.failures.has(name) ? [{ name, error: this.failures.get(name)! }] : []))
  }

  async restore(session: AgentSession, files: boolean, signal?: AbortSignal) {
    const opened = new Set<PiToolGroup>()
    for (const message of session.messages) {
      if (message.role !== 'toolResult' || message.isError || !Object.hasOwn(piDirectories, message.toolName)) continue
      opened.add(piDirectories[message.toolName as keyof typeof piDirectories])
    }
    await Promise.all([...opened].map((group) => this.connect(group, signal, false)))
    session.setActiveToolsByName([
      ...Object.keys(piDirectories),
      ...[...opened].flatMap((group) => this.names(session, group, files)),
    ])
  }
}

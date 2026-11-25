import { expect, test } from 'bun:test'
import { type EngineEvent, type Inbound, PiBridge, type PiResourcesConfig } from 'ineffa'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { type ModelReply, type ModelRequest, fixture, human, until } from './fixture'

import { browserCommand, browserServer } from '../packages/ineffa/src/browser'

async function resourceFixture(
  reply: (request: ModelRequest, index: number) => ModelReply,
  resources: (directory: string) => Promise<PiResourcesConfig>
) {
  let calls = 0
  const f = await fixture((request) => reply(request, calls++))
  const engine = await PiBridge.open(join(f.directory, 'pi'), {
    resolveModel: async () => ({
      provider: 'fixture',
      id: 'echo',
      baseURL: `http://127.0.0.1:${f.server.port}/v1`,
      apiKey: 'fixture',
    }),
    resources,
  })
  const binding = f.store.ensure('pi', human('initial', '').address, 'build', f.workspace, 'pi', 'fixture/echo')
  const events: EngineEvent[] = []
  const controller = new AbortController()
  const stream = (async () => {
    for await (const event of engine.events(controller.signal)) events.push(event)
  })()
  await engine.configureAccountPrompts(() => ({ system: 'RESOURCE_FIXTURE', context: '' }))
  await engine.ensure(binding)
  return {
    ...f,
    engine,
    binding,
    events,
    async prompt(id: string, text: string) {
      const input: Inbound = {
        id,
        bindingId: binding.id,
        message: human(id, text),
        prompt: text,
        rootId: id,
        state: 'pending',
        error: null,
        createdAt: Date.now(),
      }
      const before = events.filter((event) => event.type === 'session.execution.succeeded').length
      await engine.submit(binding, input)
      await until(() => events.filter((event) => event.type === 'session.execution.succeeded').length > before, 60_000)
    },
    async close() {
      controller.abort()
      await stream
      await engine.close()
      await f.close()
    },
  }
}

test('Pi starts a native stdio MCP only on discovery and executes the returned tool', async () => {
  let marker = ''
  let closed = ''
  const f = await resourceFixture(
    (_request, index) => {
      if (index === 0) return 'Ordinary reply'
      if (index === 1) return { tool: 'list_tools', input: {} }
      if (index === 2) return { tool: 'mcp__fixture__echo', input: { text: 'NATIVE_MCP_RESULT' } }
      return 'Done'
    },
    async (directory) => {
      marker = join(directory, 'mcp-started')
      closed = join(directory, 'mcp-closed')
      const script = join(directory, 'fixture-mcp.mjs')
      await writeFile(
        script,
        `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'started')
process.on('exit', () => writeFileSync(${JSON.stringify(closed)}, 'closed'))
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
    if (message.id === undefined) continue
    let result = {}
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
    if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.text }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`
      )
      return {
        browser: false,
        mcp: {
          fixture: { command: 'node', args: [script], timeout: 3 },
          offline: { command: 'node', args: ['-e', 'process.exit(1)'], timeout: 1 },
        },
      }
    }
  )
  try {
    await f.prompt('plain', 'Hello')
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(JSON.stringify(f.requests[0])).toContain('2 servers available on demand')
    await f.prompt('mcp', 'Use the external tool')
    expect(await Bun.file(marker).exists()).toBe(true)
    const tools = f.requests[2]!.tools as { function: { name: string } }[]
    expect(tools.some((tool) => tool.function.name === 'mcp__fixture__echo')).toBe(true)
    expect(JSON.stringify(f.requests[3])).toContain('NATIVE_MCP_RESULT')
    await f.engine.releaseSession(f.binding.sessionId)
    await until(() => Bun.file(closed).exists())
    expect((await f.engine.messages(f.binding.sessionId)).data.length).toBeGreaterThan(0)
  } finally {
    await f.close()
  }
}, 30000)

test('Pi isolates unavailable MCP servers and retries only on explicit discovery', async () => {
  let marker = ''
  const f = await resourceFixture(
    (_request, index) => {
      if (index === 0 || index === 3) return { tool: 'list_tools', input: {} }
      return 'Still available'
    },
    async (directory) => {
      marker = join(directory, 'failed-starts')
      const script = join(directory, 'failed-mcp.mjs')
      await writeFile(
        script,
        `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(1)`
      )
      return { mcp: { offline: { command: 'node', args: [script], timeout: 1 } } }
    }
  )
  try {
    await f.prompt('discover', 'List tools')
    expect(JSON.stringify(f.requests[1])).toContain('unavailable')
    expect(JSON.stringify(f.requests[1])).toContain('question')
    expect(await Bun.file(marker).text()).toBe('x')
    await f.prompt('ordinary', 'Continue normally')
    expect(await Bun.file(marker).text()).toBe('x')
    await f.prompt('retry', 'Try discovery again')
    expect(await Bun.file(marker).text()).toBe('xx')
  } finally {
    await f.close()
  }
}, 30000)

test.skipIf(process.env.INEFFA_TEST_BROWSER !== '1')(
  'Pi discovers native Playwright MCP and navigates a real headless browser',
  async () => {
    let marker = ''
    let closed = ''
    const page = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response('<title>Pi native browser fixture</title><p>Local page content</p>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    })
    const f = await resourceFixture(
      (_request, index) => {
        if (index === 0) return { tool: 'list_browser_tools', input: {} }
        if (index === 1)
          return { tool: 'mcp__ineffa_browser__browser_navigate', input: { url: `http://127.0.0.1:${page.port}/` } }
        if (index === 3) return { tool: 'mcp__ineffa_browser__browser_tabs', input: { action: 'list' } }
        return 'Browser done'
      },
      async (directory) => {
        marker = join(directory, 'browser-process')
        closed = join(directory, 'browser-closed')
        const preload = join(directory, 'browser-preload.mjs')
        await writeFile(
          preload,
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('exit', () => writeFileSync(${JSON.stringify(closed)}, 'closed'))`
        )
        const [command, ...args] = browserCommand()
        return {
          browser: true,
          mcp: { [browserServer]: { command: command!, args: ['--import', pathToFileURL(preload).href, ...args] } },
        }
      }
    )
    try {
      await f.prompt('browse', 'Visit the local page')
      expect(JSON.stringify(f.requests[0])).toContain('1 servers available on demand')
      expect(JSON.stringify(f.requests[1])).toContain('mcp__ineffa_browser__browser_navigate')
      expect(JSON.stringify(f.requests[2])).toContain('Pi native browser fixture')
      const pid = Number(await Bun.file(marker).text())
      await f.engine.releaseSession(f.binding.sessionId)
      await until(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      })
      expect(await Bun.file(closed).exists()).toBe(true)
      await f.prompt('reopen', 'List fresh browser tabs')
      const latest = f.requests[4]!.messages.findLast((message) => message.role === 'tool')
      expect(String(latest?.content)).not.toContain('Pi native browser fixture')
    } finally {
      await f.close()
      await page.stop(true)
    }
  },
  120000
)

test('Pi manually compacts idle native history and persists the summary', async () => {
  const f = await resourceFixture(
    () => 'COMPACTION_FIXTURE_SUMMARY',
    async () => ({})
  )
  try {
    await f.prompt('long-first', 'First record '.repeat(10000))
    await f.prompt('long-second', 'Recent record '.repeat(10000))
    await until(async () => !(await f.engine.active())[f.binding.sessionId])
    const result = await f.engine.compactSession(f.binding.sessionId)
    expect(result.summary).toContain('COMPACTION_FIXTURE_SUMMARY')
    const saved = await f.engine.exportSession(f.binding.sessionId)
    expect(saved.entries.some((entry) => entry.type === 'compaction')).toBe(true)
    await f.engine.releaseSession(f.binding.sessionId)
    await f.prompt('after-compaction', 'Continue')
    expect(JSON.stringify(f.requests.at(-1))).toContain('COMPACTION_FIXTURE_SUMMARY')
  } finally {
    await f.close()
  }
}, 30000)

test('Pi discovers explicit Skills and reads one natively without inheriting AGENTS', async () => {
  let skillPath = ''
  const f = await resourceFixture(
    (_request, index) => {
      if (index === 0) return { tool: 'list_skills', input: {} }
      if (index === 1) return { tool: 'read', input: { path: skillPath } }
      return 'Skill loaded'
    },
    async (directory) => {
      const skills = join(directory, 'explicit-skills')
      await mkdir(join(skills, 'recipe'), { recursive: true })
      skillPath = join(skills, 'recipe', 'SKILL.md')
      await writeFile(skillPath, '---\nname: recipe\ndescription: Useful recipe\n---\nNATIVE_SKILL_BODY')
      await writeFile(join(directory, 'AGENTS.md'), 'DO_NOT_INHERIT_AGENTS')
      return { browser: false, skills: [skills] }
    }
  )
  try {
    await f.prompt('skill', 'Read the recipe')
    expect(JSON.stringify(f.requests[0])).toContain('1 skills loaded')
    expect(JSON.stringify(f.requests[0])).not.toContain('NATIVE_SKILL_BODY')
    expect(JSON.stringify(f.requests[1])).toContain('Useful recipe')
    expect(JSON.stringify(f.requests[2])).toContain('NATIVE_SKILL_BODY')
    expect(JSON.stringify(f.requests)).not.toContain('DO_NOT_INHERIT_AGENTS')
    const boot = f.requests[0]!.tools as { function: { name: string } }[]
    expect(boot.map((tool) => tool.function.name).sort()).toEqual([
      'list_browser_tools',
      'list_coding_tools',
      'list_skills',
      'list_tools',
    ])
  } finally {
    await f.close()
  }
}, 30000)

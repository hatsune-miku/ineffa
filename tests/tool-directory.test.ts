import { expect, test } from 'bun:test'
import { Host, OpenCodeBridge, Store } from 'ineffa'
import { kook } from 'ineffa-kook'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Plugin } from '@opencode/plugin'
import { OpenCode } from '@opencode/sdk'

import { type ModelRequest, TestAdapter, fixture, human, systemText, until } from './fixture'

import { accountPrompt } from '../packages/ineffa/src/prompt'
import { directoryTools } from '../packages/ineffa/src/tool-directory'

function names(request: ModelRequest): string[] {
  return (request.tools as { function: { name: string } }[]).map((tool) => tool.function.name)
}

function toolResult(request: ModelRequest) {
  return String(request.messages.filter((message) => message.role === 'tool').at(-1)?.content)
}

test('upgrading a native session stops replaying inherited instruction sources', async () => {
  const f = await fixture(() => 'DONE')
  let legacy: OpenCode.Interface | undefined
  let upgraded: Host | undefined
  let closed = false
  try {
    await writeFile(join(f.workspace, 'AGENTS.md'), 'LEGACY_EXTERNAL_INSTRUCTION')
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    const binding = await f.host.createConversation('A', human('source', '').address)
    await f.host.close()
    closed = true
    legacy = await OpenCode.create({
      ...f.config,
      config: { ...f.config.config, directory: f.engine.configDirectory },
      database: { path: f.engine.databasePath },
    })
    await legacy.sessions.prompt({ sessionID: binding.sessionId, text: 'hello' })
    await legacy.sessions.wait({ sessionID: binding.sessionId })
    expect(JSON.stringify(f.requests.at(-1)!)).toContain('LEGACY_EXTERNAL_INSTRUCTION')
    await legacy.close()
    legacy = undefined

    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    upgraded = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    const restored = new TestAdapter('A', f.workspace)
    await upgraded.addAdapter(restored)
    await upgraded.start()
    await upgraded.receive('A', human('upgraded', 'hello again'))
    await until(() => f.requests.length >= 2 && restored.sent.some((message) => message.text === 'DONE'))
    expect(JSON.stringify(f.requests.at(-1)!)).not.toContain('LEGACY_EXTERNAL_INSTRUCTION')
    expect(names(f.requests.at(-1)!)).toHaveLength(4)
  } finally {
    await legacy?.close()
    await upgraded?.close()
    if (!closed) await f.host.close()
    await f.server.stop(true)
  }
}, 30_000)

test('directories open native tools per session, survive restart, and stay out of debug and status', async () => {
  let step = 0
  const f = await fixture((request) => {
    step++
    if (step === 1) {
      expect(names(request).sort()).toEqual(Object.keys(directoryTools).sort())
      expect(systemText(request)).toContain('44 browser-specific tools loaded.')
      return { tool: 'list_coding_tools', input: {} }
    }
    if (step === 2) {
      expect(names(request)).toContain('write')
      expect(names(request)).not.toContain('question')
      expect(toolResult(request)).toContain('"name":"write"')
      expect(toolResult(request)).toContain('"input"')
      return { tool: 'write', input: { path: 'discovered.txt', content: 'NATIVE_WRITE' } }
    }
    return 'DONE'
  })
  let restarted: Host | undefined
  try {
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('debug', '/debug on'))
    await f.host.receive('A', human('start', 'Use a coding tool'))
    await until(() => adapter.sent.some((message) => message.text.startsWith('DONE')))
    expect(await readFile(join(f.workspace, 'discovered.txt'), 'utf8')).toBe('NATIVE_WRITE')
    expect(adapter.sent.find((message) => message.text.startsWith('DONE'))?.notes?.join('\n')).toContain('工具 1 次')
    expect(JSON.stringify(adapter.sent)).not.toContain('list_coding_tools')
    expect(names(f.requests[2]!)).toContain('write')

    const b = new TestAdapter('B', f.workspace)
    await f.host.addAdapter(b)
    await f.host.receive('B', human('fresh', 'list_coding_tools was called', ['B']))
    await until(() => b.sent.some((message) => message.text === 'DONE'))
    expect(names(f.requests.at(-1)!)).toHaveLength(4)

    await f.host.close()
    const engine = await OpenCodeBridge.open(join(f.directory, 'engine'), f.config)
    restarted = new Host(new Store(join(f.directory, 'ineffa.sqlite')), engine)
    const restored = new TestAdapter('A', f.workspace)
    await restarted.addAdapter(restored)
    await restarted.start()
    await restarted.receive('A', human('restart', 'continue'))
    await until(() => restored.sent.some((message) => message.text.startsWith('DONE')))
    expect(names(f.requests.at(-1)!)).toContain('write')
    await restarted.receive('A', human('new', '/new'))
    await restarted.receive('A', human('after-new', 'hello'))
    await until(() => restored.sent.filter((message) => message.text.startsWith('DONE')).length === 2)
    expect(names(f.requests.at(-1)!)).toHaveLength(4)
  } finally {
    if (restarted) {
      await restarted.close()
      await f.server.stop(true)
    } else await f.close()
  }
}, 40_000)

test('native compaction can rediscover tools without a separate persisted directory state', async () => {
  let phase: 'initial' | 'compact' | 'after' = 'initial'
  let wrote = false
  const f = await fixture((request) => {
    if (phase === 'compact') return 'User wants coding work. Previously called list_coding_tools.'
    if (!names(request).includes('write')) return { tool: 'list_coding_tools', input: {} }
    if (phase === 'after' && !wrote) {
      wrote = true
      return { tool: 'write', input: { path: 'after-compaction.txt', content: 'COMPACTED_WRITE' } }
    }
    return 'DONE'
  })
  try {
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('start', 'Prepare for coding'))
    await until(() => adapter.sent.some((message) => message.text === 'DONE'))
    const binding = f.store.current('A', 'channel:guild:1')!
    phase = 'compact'
    await f.engine.native.sessions.compact({ sessionID: binding.sessionId })
    await f.engine.native.sessions.wait({ sessionID: binding.sessionId })
    const before = f.requests.length
    phase = 'after'
    await f.host.receive('A', human('after', 'Write the file'))
    await until(() => adapter.sent.filter((message) => message.text === 'DONE').length === 2)
    expect(await readFile(join(f.workspace, 'after-compaction.txt'), 'utf8')).toBe('COMPACTED_WRITE')
    expect(f.requests.length).toBeGreaterThan(before)
    for (const request of f.requests.slice(before)) {
      for (const tool of Object.keys(directoryTools)) expect(names(request)).toContain(tool)
    }
  } finally {
    await f.close()
  }
}, 30_000)

test('all browser schemas are discoverable; skills load only on demand and respect permissions', async () => {
  let step = 0
  const f = await fixture((request) => {
    step++
    if (step === 1) {
      expect(JSON.stringify(request)).not.toContain('SKILL_BODY_MARKER')
      expect(JSON.stringify(request)).not.toContain('DENIED_SKILL_DESCRIPTION')
      return { tool: 'list_skills', input: {} }
    }
    if (step === 2) {
      expect(toolResult(request)).toContain('Allowed skill description')
      expect(toolResult(request)).not.toContain('SKILL_BODY_MARKER')
      expect(toolResult(request)).not.toContain('DENIED_SKILL_DESCRIPTION')
      expect(names(request)).toContain('skill')
      return { tool: 'skill', input: { id: 'directory-allowed' } }
    }
    if (step === 3) {
      expect(toolResult(request)).toContain('SKILL_BODY_MARKER')
      return { tool: 'list_browser_tools', input: {} }
    }
    if (step === 4) {
      const tools = JSON.parse(toolResult(request)).tools as { name: string; input: { type?: string } }[]
      expect(tools).toHaveLength(44)
      expect(tools.every((tool) => names(request).includes(tool.name))).toBe(true)
      expect(tools.every((tool) => tool.input.type === 'object')).toBe(true)
      const sent = request.tools as { function: { parameters: { type?: string } } }[]
      expect(sent.every((tool) => tool.function.parameters.type === 'object')).toBe(true)
      return { tool: 'list_tools', input: {} }
    }
    if (step === 5) {
      expect(names(request)).toContain('question')
      expect(names(request)).not.toContain('send_file')
      expect(toolResult(request)).not.toContain('send_file')
      expect(names(request)).not.toContain('write')
    }
    return 'DONE'
  })
  try {
    await f.engine.native.plugin(
      Plugin.define({
        id: 'test.directory-skills',
        async setup(context) {
          await context.skill.transform((editor) => {
            for (const id of ['allowed', 'denied'])
              editor.add({
                id: `directory-${id}`,
                name: `directory-${id}`,
                location: join(f.workspace, 'SKILL.md'),
                description: id === 'allowed' ? 'Allowed skill description' : 'DENIED_SKILL_DESCRIPTION',
                content: 'SKILL_BODY_MARKER',
              } as never)
          })
          await context.agent.transform((editor) =>
            editor.update('build', (agent) => {
              agent.permissions.push({ action: 'skill', resource: 'directory-denied', effect: 'deny' })
            })
          )
        },
      })
    )
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('start', 'Find tools and a skill'))
    await until(() => adapter.sent.some((message) => message.text === 'DONE'))
    expect(step).toBe(5)
  } finally {
    await f.close()
  }
}, 30_000)

test('late plugin tools retain native execution and only the four directory names are excluded from debug', async () => {
  let step = 0
  const f = await fixture((request) => {
    step++
    if (step === 1) return { tool: 'list_tools', input: {} }
    if (step === 2) {
      expect(toolResult(request)).toContain('list_records')
      expect(toolResult(request)).toContain('fixture_probe')
      return { tool: 'list_records', input: {} }
    }
    if (step === 3) {
      expect(toolResult(request)).toBe('NATIVE_LIST_RESULT')
      return { tool: 'fixture_probe', input: {} }
    }
    if (step === 4) {
      expect(toolResult(request)).toBe('NATIVE_PLUGIN_RESULT')
      return { tool: 'list_coding_tools', input: {} }
    }
    if (step === 5) {
      expect(names(request)).not.toContain('write')
      expect(toolResult(request)).not.toContain('"name":"write"')
    }
    return 'DONE'
  })
  try {
    await f.engine.native.plugin(
      Plugin.define({
        id: 'test.late-tools',
        async setup(context) {
          await context.tool.transform((editor) => {
            editor.add({
              name: 'list_records',
              description: 'List test records.',
              input: { type: 'object', properties: {} },
              execute: async () => ({ content: 'NATIVE_LIST_RESULT' }),
            })
            editor.add({
              name: 'probe',
              options: { namespace: 'fixture', codemode: true },
              description: 'Probe a dynamically registered tool.',
              input: { type: 'object', properties: {} },
              execute: async () => ({ content: 'NATIVE_PLUGIN_RESULT' }),
            })
          })
        },
      })
    )
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('debug', '/debug on'))
    const binding = f.store.current('A', 'channel:guild:1')!
    await f.engine.native.permission.rules({
      sessionID: binding.sessionId,
      permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
    })
    await f.host.receive('A', human('start', 'List records and probe'))
    await until(() => adapter.sent.some((message) => message.text.startsWith('DONE')))
    expect(adapter.sent.find((message) => message.text.startsWith('DONE'))?.notes?.join('\n')).toContain('工具 2 次')
    expect(adapter.sent.find((message) => message.kind === 'reply')?.notes?.join('\n')).toContain('list_records x1')
    expect(JSON.stringify(adapter.sent)).not.toContain('list_tools')
    expect(step).toBe(5)

    await f.engine.native.permission.rules({
      sessionID: binding.sessionId,
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    })
    await f.host.receive('A', human('denied', 'continue'))
    await until(() => step === 6)
    expect(names(f.requests.at(-1)!).sort()).toEqual(Object.keys(directoryTools).sort())
    expect(systemText(f.requests.at(-1)!)).toContain('0 skills loaded.')
    expect(systemText(f.requests.at(-1)!)).toContain('0 generic tools loaded.')
  } finally {
    await f.close()
  }
}, 30_000)

test('external instructions never enter initial or continued context; only KOOK adds its formatting rules', async () => {
  const f = await fixture(() => 'DONE', {}, 0, true)
  try {
    await writeFile(join(f.workspace, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MARKER')
    await writeFile(join(f.engine.configDirectory, 'AGENTS.md'), 'GLOBAL_INSTRUCTION_MARKER')
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('start', 'hello'))
    await until(() => adapter.sent.length === 1)
    await writeFile(join(f.workspace, 'AGENTS.md'), 'CHANGED_INSTRUCTION_MARKER')
    await f.host.receive('A', human('continue', 'hello again'))
    await until(() => adapter.sent.length === 2)
    for (const request of f.requests) {
      expect(JSON.stringify(request)).not.toContain('INSTRUCTION_MARKER')
      expect(systemText(request)).not.toContain('KOOK')
      expect(systemText(request)).not.toContain('LaTeX')
    }
    const kookAdapter = kook({ id: 'kook', token: 'fixture', directory: f.workspace })
    expect(kookAdapter.promptInstructions).toContain('不要使用 Markdown 表格、LaTeX 或以 # 开头的标题')
    expect(accountPrompt(adapter, [])?.context ?? '').not.toContain('LaTeX')
  } finally {
    await f.close()
  }
}, 30_000)

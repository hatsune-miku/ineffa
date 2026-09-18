import { Effect, Layer } from 'effect'

import { InstructionDiscovery } from '@opencode/core/instruction-discovery'
import { Permission } from '@opencode/core/permission'
import { SessionContext as NativeContext } from '@opencode/core/session/context'
import { Tool as NativeTool } from '@opencode/core/tool'
import { Plugin } from '@opencode/plugin'
import type { SessionContext } from '@opencode/plugin/promise/session'

import type { AccountPrompt } from './prompt'

export const directoryTools = {
  list_skills: 'skills',
  list_browser_tools: 'browser',
  list_coding_tools: 'coding',
  list_tools: 'generic',
} as const

type Group = (typeof directoryTools)[keyof typeof directoryTools]
type Tool = SessionContext['tools'][string]
type Catalog = { tools: Record<string, Tool>; skills: { id: string; name: string; description?: string }[] }

const codingTools = new Set(['edit', 'glob', 'grep', 'read', 'shell', 'write', 'subagent'])
const hiddenSources = new Set(['core/instructions', 'core/skill-guidance', 'core/codemode'])

// Use OpenCode's embedding hooks: do not patch its package or maintain a second history.
export const instructionOverrides = [
  InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
  NativeTool.node.replace(
    NativeTool.node.mapLayer((layer) =>
      Layer.effect(
        NativeTool.Service,
        Effect.gen(function* directTools() {
          const original = yield* NativeTool.Service
          return {
            ...original,
            // These four metadata readers remain discoverable even in a deny-all session.
            snapshot: (permissions = []) =>
              original.snapshot([
                ...permissions,
                ...Object.keys(directoryTools).map((action) => ({ action, resource: '*', effect: 'allow' as const })),
              ]),
            transform: (transform) =>
              original.transform((editor) => {
                transform(editor)
                // Also applies to tools registered later, including MCP refreshes.
                for (const tool of editor.list()) {
                  if (tool.options?.codemode === false) continue
                  editor.update(tool.id, (draft) => {
                    const { pinned: _pinned, ...options } = draft.options ?? {}
                    draft.options = { ...options, codemode: false }
                  })
                }
              }),
          }
        })
      ).pipe(Layer.provide(layer))
    )
  ),
  NativeContext.node.replace(
    NativeContext.node.mapLayer((layer) =>
      Layer.effect(
        NativeContext.Service,
        Effect.gen(function* instructionSources() {
          const original = yield* NativeContext.Service
          return {
            ...original,
            select: (sessionID) =>
              original.select(sessionID).pipe(
                Effect.map((selection) => ({
                  ...selection,
                  instructions: selection.instructions.filter((source) => !hiddenSources.has(source.key)),
                }))
              ),
          }
        })
      ).pipe(Layer.provide(layer))
    )
  ),
]

export function isDirectoryTool(name: string): name is keyof typeof directoryTools {
  return Object.hasOwn(directoryTools, name)
}

function toolGroup(name: string): Group {
  if (name === 'skill') return 'skills'
  if (name.startsWith('browser_')) return 'browser'
  if (name.startsWith('opencode_') || codingTools.has(name)) return 'coding'
  return 'generic'
}

function listedGroups(messages: SessionContext['messages']): Set<Group> {
  const groups = new Set<Group>()
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.result.type !== 'error' && isDirectoryTool(part.name)) {
        groups.add(directoryTools[part.name])
      }
    }
  }
  return groups
}

function normalizeToolInput(tool: Tool) {
  const input = tool.input
  // OpenCode emits this union for an empty Effect struct. Direct function tools
  // need an object root; {} is also accepted by the original native validator.
  if (
    input.type === undefined &&
    Array.isArray(input.anyOf) &&
    input.anyOf.length === 2 &&
    input.anyOf.every((branch) => Object.keys(branch).length === 1) &&
    input.anyOf.some((branch) => branch.type === 'object') &&
    input.anyOf.some((branch) => branch.type === 'array')
  ) {
    const { anyOf: _anyOf, ...annotations } = input
    tool.input = { ...annotations, type: 'object', properties: {}, additionalProperties: false }
  }
}

export function toolDirectory(resolvePrompt: (sessionId: string) => AccountPrompt | undefined) {
  return Plugin.define({
    id: 'ineffa.tool-directory',
    async setup(context) {
      // Request snapshots only; discovery state comes from native tool results in the active transcript.
      const catalogs = new Map<string, Catalog>()
      const controller = new AbortController()
      const cleanup = (async () => {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          )
            catalogs.delete(event.data.sessionID)
        }
      })()
      void cleanup.catch(() => {})

      await context.tool.transform((editor) => {
        for (const [name, group] of Object.entries(directoryTools)) {
          editor.add({
            name,
            description:
              group === 'skills'
                ? 'List available skills and enable the skill tool to load one by ID.'
                : `List ${group === 'coding' ? 'OpenCode and coding-specific' : group === 'browser' ? 'browser-specific' : 'generic'} tools. Their definitions become available on the next response.`,
            options: { codemode: false },
            input: { type: 'object', properties: {}, additionalProperties: false },
            async execute(_input, tool) {
              const catalog = catalogs.get(tool.sessionID)
              if (!catalog) throw new Error('Tool directory is unavailable; retry the request.')
              const entries = Object.entries(catalog.tools)
                .filter(([name]) => toolGroup(name) === group)
                .map(([name, definition]) => ({ name, ...definition }))
              return {
                content: JSON.stringify(
                  group === 'skills' ? { skills: catalog.skills, tools: entries } : { tools: entries }
                ),
              }
            },
          })
        }
      })

      async function prepare(event: SessionContext) {
        // Every underlying tool is now direct; the empty Code Mode wrapper is unnecessary.
        delete event.tools.execute
        for (const tool of Object.values(event.tools)) normalizeToolInput(tool)
        const prompt = resolvePrompt(event.sessionID)
        const [skillList, agent, session] = await Promise.all([
          context.skill.list(),
          context.agent.get({ agentID: event.agent }),
          context.session.get({ sessionID: event.sessionID }),
        ])
        const skills = skillList.data
          .filter(
            (skill) =>
              Permission.evaluate('skill', skill.id, agent.data.permissions, session.permissions ?? []).effect !==
              'deny'
          )
          .map(({ id, name, description }) => ({ id, name, description }))
          .sort((left, right) => left.id.localeCompare(right.id))
        const tools = Object.fromEntries(Object.entries(event.tools).filter(([name]) => !isDirectoryTool(name)))
        catalogs.set(event.sessionID, { tools, skills })
        const groups = listedGroups(event.messages)
        for (const name of Object.keys(tools)) {
          if (!groups.has(toolGroup(name))) delete event.tools[name]
        }
        const counts = { browser: 0, coding: 0, generic: 0, skills: 0 }
        for (const name of Object.keys(tools)) counts[toolGroup(name)]++
        const environment = [
          '<env>',
          `Current conversation session ID: ${event.sessionID}`,
          `Working directory: ${context.location.directory}`,
          `Workspace root folder: ${context.location.project.directory}`,
          `Platform: ${process.platform}`,
          `Date: ${new Date().toISOString().slice(0, 10)}`,
          '</env>',
        ].join('\n')
        event.system = [
          {
            type: 'text',
            text: [
              '你由 OpenCode 驱动，但不代表你是编程/开发特化的 Agent——不要假设用户的专业领域，你只作为通用智能处理用户的请求。',
              prompt?.system,
              prompt?.context,
              environment,
              `${skills.length} skills loaded. Call \`list_skills\` to view.`,
              `${counts.browser} browser-specific tools loaded. Call \`list_browser_tools\` to view.`,
              `${counts.coding} OpenCode and coding-specific tools loaded. Call \`list_coding_tools\` to view.`,
              `${counts.generic} generic tools loaded. Call \`list_tools\` to view.`,
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ]
      }
      await context.session.hook('context', prepare)
      await context.session.hook('generate', prepare)
      return async () => {
        controller.abort()
        await cleanup.catch(() => {})
        catalogs.clear()
      }
    },
  })
}

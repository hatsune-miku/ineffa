import { expect, test } from 'bun:test'

import { Plugin } from '@opencode/plugin'

import { TestAdapter, fixture, human, until } from './fixture'

test('empty native inputs advertise object schemas and still execute with native validation', async () => {
  let step = 0
  let calls = 0
  const f = await fixture((request) => {
    const tools = request.tools as {
      function: { name: string; parameters: Record<string, unknown> }
    }[]
    // Match providers that reject the whole request if even one tool has no object root.
    expect(tools.every((tool) => tool.function.parameters.type === 'object')).toBe(true)
    if (++step === 1) return { tool: 'list_browser_tools', input: {} }
    const list = tools.find((tool) => tool.function.name === 'browser_fixture_empty')!
    expect(list.function.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    if (step === 2) return { tool: 'browser_fixture_empty', input: {} }
    const result = request.messages.findLast((message) => message.role === 'tool')
    expect(JSON.stringify(result?.content)).toContain('EMPTY_INPUT_OK')
    return 'DONE'
  })
  try {
    await f.engine.native.plugin(
      Plugin.define({
        id: 'test.empty-input',
        async setup(context) {
          await context.tool.transform((editor) =>
            editor.add({
              name: 'browser_fixture_empty',
              description: 'Test an empty native input schema.',
              input: { anyOf: [{ type: 'object' }, { type: 'array' }] },
              async execute(input) {
                expect(input).toEqual({})
                calls++
                return { content: 'EMPTY_INPUT_OK' }
              },
            })
          )
        },
      })
    )
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('list', 'List the browser tabs'))
    await until(() => adapter.sent.some((message) => message.text === 'DONE'))
    expect(step).toBe(3)
    expect(calls).toBe(1)
  } finally {
    await f.close()
  }
}, 30_000)

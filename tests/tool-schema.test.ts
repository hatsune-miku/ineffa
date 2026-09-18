import { expect, test } from 'bun:test'

import { TestAdapter, fixture, human, until } from './fixture'

test('empty browser inputs advertise object schemas and still execute with native validation', async () => {
  let step = 0
  const f = await fixture((request) => {
    const tools = request.tools as {
      function: { name: string; parameters: Record<string, unknown> }
    }[]
    // Match providers that reject the whole request if even one tool has no object root.
    expect(tools.every((tool) => tool.function.parameters.type === 'object')).toBe(true)
    if (++step === 1) return { tool: 'list_browser_tools', input: {} }
    const list = tools.find((tool) => tool.function.name === 'browser_tabs_list')!
    expect(list.function.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    const navigate = tools.find((tool) => tool.function.name === 'browser_navigate')!
    expect(navigate.function.parameters.required).toEqual(['tabID', 'url'])
    if (step === 2) return { tool: 'browser_tabs_list', input: {} }
    // The fixture has no desktop browser. This native error proves {} passed
    // argument validation and reached the browser implementation.
    const result = request.messages.findLast((message) => message.role === 'tool')
    expect(JSON.stringify(result?.content)).toContain('[browser.disconnected]')
    return 'DONE'
  })
  try {
    const adapter = new TestAdapter('A', f.workspace)
    await f.host.addAdapter(adapter)
    await f.host.receive('A', human('list', 'List the browser tabs'))
    await until(() => adapter.sent.some((message) => message.text === 'DONE'))
    expect(step).toBe(3)
  } finally {
    await f.close()
  }
}, 30_000)

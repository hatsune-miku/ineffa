import { expect, test } from 'bun:test'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TestAdapter, fixture, human, systemText, until } from './fixture'

// Requires the pinned Chromium installed by `bun run browser:install`.
test.skipIf(process.env.INEFFA_TEST_BROWSER !== '1')(
  'headless browser navigates, clicks, captures, survives debug toggles and isolates workspaces',
  async () => {
    const page = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(
          '<title>Ineffa browser test</title><button onclick="this.textContent=\'Clicked successfully\'">Change</button>',
          {
            headers: { 'Content-Type': 'text/html' },
          }
        ),
    })
    let step = 0
    let screenshot = ''
    const url = `http://127.0.0.1:${page.port}/`
    const f = await fixture(
      async (request) => {
        const tools = request.tools as { function: { name: string; parameters: { type?: string } } }[]
        const names = tools.map((tool) => tool.function.name)
        expect(names).not.toContain('browser_tabs_list')
        expect(tools.every((tool) => tool.function.parameters.type === 'object')).toBe(true)
        const result = String(request.messages.findLast((message) => message.role === 'tool')?.content)
        step++
        if (step === 1) {
          expect(systemText(request)).not.toContain('0 browser-specific tools loaded.')
          return { tool: 'list_browser_tools', input: {} }
        }
        if (step === 2) {
          expect(names).toContain('ineffa_browser_browser_navigate')
          return { tool: 'ineffa_browser_browser_navigate', input: { url } }
        }
        if (step === 3) {
          expect(result).toContain('Ineffa browser test')
          return { tool: 'ineffa_browser_browser_click', input: { target: 'button' } }
        }
        if (step === 4) {
          const snapshot = /\[Snapshot\]\(([^)]+)\)/.exec(result)?.[1]
          expect(snapshot).toBeDefined()
          expect(await readFile(join(f.workspace, snapshot!), 'utf8')).toContain('Clicked successfully')
          return {
            tool: 'ineffa_browser_browser_take_screenshot',
            input: { type: 'png', scale: 'css', filename: screenshot },
          }
        }
        if (step === 5) expect(result.slice(0, 1500)).not.toContain('error')
        if (step === 6) return { tool: 'ineffa_browser_browser_tabs', input: { action: 'list' } }
        if (step === 7) {
          expect(result).toContain(url)
          return 'DONE'
        }
        if (step === 8) return { tool: 'list_browser_tools', input: {} }
        if (step === 9 || step === 11) return { tool: 'ineffa_browser_browser_tabs', input: { action: 'list' } }
        if (step === 10) {
          expect(result).not.toContain(url)
          return 'DONE'
        }
        if (step === 12) {
          expect(result).toContain(url)
          return { tool: 'ineffa_browser_browser_close', input: {} }
        }
        return 'DONE'
      },
      {},
      0,
      false,
      true
    )
    try {
      screenshot = join(f.workspace, 'browser-test.png')
      const adapter = new TestAdapter('A', f.workspace)
      await f.host.addAdapter(adapter)
      await f.host.receive('A', human('browse', 'Test the browser'))
      await until(() => adapter.sent.some((message) => message.text === 'DONE'), 60_000)
      const png = await readFile(screenshot)
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      await f.host.receive('A', human('debug', '/debug on'))
      await f.host.receive('A', human('continue', 'List the same tabs'))
      await until(() => adapter.sent.filter((message) => message.text === 'DONE').length === 2, 30_000)
      const otherDirectory = join(f.directory, 'other-workspace')
      await mkdir(otherDirectory)
      const other = new TestAdapter('B', otherDirectory)
      await f.host.addAdapter(other)
      await f.host.receive('B', human('other', 'List your tabs', ['B']))
      await until(() => other.sent.some((message) => message.text === 'DONE'), 30_000)
      await f.host.receive('A', human('close', 'Confirm your tabs, then close'))
      await until(() => adapter.sent.filter((message) => message.text === 'DONE').length === 3, 30_000)
      expect(step).toBe(13)
    } finally {
      await f.close()
      await page.stop(true)
    }
  },
  120_000
)

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.resolve('@playwright/mcp'))
const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js')
const child = Bun.spawn(['node', cli, 'install', 'chromium', ...process.argv.slice(2)], {
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exitCode = await child.exited

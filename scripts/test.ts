import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve('test-results')
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, 'run-'))
const child = Bun.spawn([process.execPath, 'test', 'tests'], {
  env: { ...process.env, INEFFA_TEST_DIR: directory },
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
})
const code = await child.exited
// Bun 1.3.9 on Windows may retain SQLite file handles until process exit.
const path = relative(root, directory)
if (path.startsWith('..') || path.includes(sep) || !path.startsWith('run-'))
  throw new Error('Unexpected test output path')
await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
process.exitCode = code

import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import type { ConfigArchive, MergePreview } from '../src/config-transfer'

const directory = process.argv[2] ? resolve(process.argv[2]) : undefined
if (!directory) throw new Error('用法：bun run scripts/docker-smoke.ts release/部署包目录')
const values = Object.fromEntries(
  (await Bun.file(resolve(directory, '.env')).text())
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
const project = `ineffa-smoke-${crypto.randomUUID().slice(0, 8)}`
const port = process.env.INEFFA_SMOKE_PORT ?? '14097'
const environment = { ...process.env, ...values, INEFFA_PORT: port }
const base = `http://127.0.0.1:${port}`

async function compose(args: string[]) {
  const child = Bun.spawn(['docker', 'compose', '--project-name', project, ...args], {
    cwd: directory,
    env: environment,
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const output = await new Response(child.stdout).text()
  assert.equal(await child.exited, 0, `docker compose ${args[0]} failed`)
  return output.trim()
}

async function api(path: string, body?: object) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${values.INEFFA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`)
  return response.json()
}

try {
  await compose(['up', '-d', '--wait', '--wait-timeout', '120'])
  assert.equal(await compose(['port', 'ineffa', '4097']), `127.0.0.1:${port}`)
  assert.equal((await fetch(base + '/api/sessions')).status, 401)
  assert.ok((await (await fetch(base)).text()).includes('<div id="root">'))
  assert.equal((await api('/api/health')).status, 'ready')
  assert.equal((await api('/api/adapters')).adapters.length, 1)
  assert.equal(await compose(['exec', '-T', 'ineffa', 'id', '-un']), 'bun')
  const session = await api('/api/sessions', { title: 'Docker persistence check' })
  await compose(['exec', '-T', 'ineffa', 'bun', '-e', "await Bun.write('/app/workspace/smoke.txt', 'persisted')"])
  console.log('Container startup, authentication, loopback port and session creation passed.')
  await api('/api/integrations/key', { id: 'openai', key: 'local-smoke-key' })
  const archive = (await api('/api/config/export', {})) as ConfigArchive
  assert.equal(archive.credentials.openai?.[0]?.value.key, 'local-smoke-key')
  archive.opencode.default_agent = 'build'
  archive.credentials.openai![0]!.value.key = 'imported-smoke-key'
  const preview = (await api('/api/config/preview', { archive })) as MergePreview
  await api('/api/config/import', {
    archive,
    revision: preview.revision,
    choices: preview.items.map((item) => ({ key: item.key, action: 'import', directory: item.directory })),
  })
  assert.equal((await api('/api/config/status')).pending, true)
  await compose(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120'])
  assert.equal((await api(`/api/sessions/${session.id}`)).binding.sessionId, session.sessionId)
  assert.equal(await compose(['exec', '-T', 'ineffa', 'cat', '/app/workspace/smoke.txt']), 'persisted')
  console.log('Session and workspace survived container recreation.')
  const imported = (await api('/api/config/export', {})) as ConfigArchive
  assert.equal(imported.opencode.default_agent, 'build')
  assert.equal(imported.credentials.openai?.[0]?.value.key, 'imported-smoke-key')
  assert.equal((await api('/api/config/status')).pending, false)
  console.log('Plaintext configuration and credentials imported successfully across container recreation.')
} finally {
  // This unique Compose project owns only the disposable smoke-test volumes.
  await compose(['down', '--volumes', '--remove-orphans'])
}

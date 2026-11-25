import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readPiResources } from '../src/pi-settings'

test('Pi reads the WebUI resource config, including JSONC, workspace paths and disabled servers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ineffa-pi-settings-'))
  try {
    const workspace = join(directory, 'workspace')
    await mkdir(workspace)
    await Bun.write(join(directory, 'opencode.json'), '{}')
    await Bun.write(
      join(directory, 'opencode.jsonc'),
      JSON.stringify({
        skills: ['team/skills', 'https://example.invalid/shared'],
        mcp: {
          timeout: { execution: 5000 },
          servers: {
            local: { type: 'local', command: ['node', 'fixture.js'], cwd: 'tools', environment: { MODE: 'test' } },
            remote: {
              type: 'remote',
              url: 'https://example.invalid/mcp',
              headers: { 'X-Test': 'fixture' },
              timeout: { execution: 1500 },
            },
            sleeping: { type: 'local', command: ['unused'], disabled: true },
          },
        },
      })
    )
    const config = await readPiResources(directory, workspace, false)
    expect(config.browser).toBe(false)
    expect(config.skills).toEqual([join(workspace, 'team/skills')])
    expect(config.mcp?.local).toMatchObject({
      command: 'node',
      args: ['fixture.js'],
      cwd: join(workspace, 'tools'),
      env: { MODE: 'test' },
      timeout: 5,
    })
    expect(config.mcp?.remote).toMatchObject({
      url: 'https://example.invalid/mcp',
      headers: { 'X-Test': 'fixture' },
      timeout: 1.5,
    })
    expect(config.mcp?.sleeping?.enabled).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

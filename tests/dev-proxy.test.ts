import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { fixture, until } from './fixture'

import { AccountsConfig } from '../src/config'
import { createServer } from '../src/server'

test('Vite accepts arbitrary origins, Referer and cross-site requests including preflight', async () => {
  const f = await fixture(() => 'unused')
  const app = createServer(f.host, {
    directory: f.workspace,
    accounts: new AccountsConfig(join(f.directory, 'accounts.json')),
    port: 0,
  })
  const readyFile = join(f.directory, 'vite-port.json')
  // Run Vite with Node, matching the dev:web command's runtime.
  const proxy = Bun.spawn(
    [
      'node',
      '--input-type=module',
      '--eval',
      `
    import { writeFileSync } from 'node:fs'
    import { createServer, loadConfigFromFile } from 'vite'

    const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' })
    config.server.port = 0
    config.server.strictPort = false
    config.server.proxy['/api/'].target = process.env.INEFFA_TEST_BACKEND
    const server = await createServer({ ...config, configFile: false, logLevel: 'silent' })
    await server.listen()
    writeFileSync(process.env.INEFFA_TEST_PROXY_READY, JSON.stringify(server.httpServer.address().port))
  `,
    ],
    {
      env: {
        ...process.env,
        INEFFA_TEST_BACKEND: `http://127.0.0.1:${app.server.port}`,
        INEFFA_TEST_PROXY_READY: readyFile,
      },
      stdout: 'ignore',
      stderr: 'inherit',
    }
  )
  try {
    await until(() => {
      if (proxy.exitCode !== null) throw new Error(`Vite exited with code ${proxy.exitCode}`)
      return existsSync(readyFile)
    })
    const port: number = await Bun.file(readyFile).json()
    for (const hostname of ['localhost', '127.0.0.1']) {
      const origin = `http://${hostname}:${port}`
      const response = await fetch(`${origin}/api/adapters`, {
        signal: AbortSignal.timeout(5000),
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
        // Invalid account data verifies routing without saving credentials or connecting a Bot.
        body: '{}',
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('invalid_account_id')
    }

    const origin = `http://127.0.0.1:${port}`
    for (const foreign of ['https://evil.example', 'null', `http://127.0.0.1:${port + 1}`]) {
      const response = await fetch(`${origin}/api/health`, {
        headers: { Origin: foreign, Referer: 'https://another.example/page' },
        signal: AbortSignal.timeout(5000),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe(foreign)
    }
    const crossSite = await fetch(`${origin}/api/health`, {
      headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
      signal: AbortSignal.timeout(5000),
    })
    expect(crossSite.status).toBe(200)
    const preflight = await fetch(`${origin}/api/adapters`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://other.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-custom-header',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://other.example')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-custom-header')
    expect(f.host.adapters.size).toBe(0)
  } finally {
    proxy.kill()
    await proxy.exited
    await app.close()
    await f.close()
  }
}, 30_000)

import { expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'

import { until } from './fixture'

import { KookClient } from '../packages/ineffa-kook/node_modules/@kookapp/js-sdk'

for (const compression of [false, true]) {
  test(`KOOK accepts documented PONG without d (compression=${compression})`, async () => {
    let pings = 0
    let connections = 0
    let socket: Bun.ServerWebSocket<undefined> | undefined
    function frame(value: object) {
      const text = JSON.stringify(value)
      return compression ? deflateSync(text) : text
    }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return
        return new Response('Not found', { status: 404 })
      },
      websocket: {
        open(ws: Bun.ServerWebSocket<undefined>) {
          socket = ws
          connections++
          ws.send(frame({ s: 1, d: { code: 0, session_id: `session-${connections}` } }))
        },
        message(ws, data) {
          if (JSON.parse(String(data)).s !== 2) return
          pings++
          ws.send(frame({ s: 3 }))
        },
      },
    })
    const errors: unknown[] = []
    const client = new KookClient({
      botToken: 'local-test',
      compression,
      timing: { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 30, heartbeatRetryDelayMs: 5 },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    client.api.openGateway = async () => ({ success: true, data: { url: `ws://127.0.0.1:${server.port}` } }) as never
    client.on('error', (error) => errors.push(error))
    try {
      client.ws.connect()
      await client.ws.waitUntilConnected(1_000)
      await until(() => pings >= 5, 2_000)
      await until(() => client.ws.currentState === 'CONNECTED', 1_000)
      expect(connections).toBe(1)
      expect(errors).toEqual([])
      socket!.send(frame({ s: 5, d: { code: 40107 } }))
      await until(() => connections === 2 && client.ws.currentState === 'CONNECTED')
      expect(client.ws.processedSn).toBe(0)
    } finally {
      client.disconnect()
      await server.stop(true)
    }
  })
}

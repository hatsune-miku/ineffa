import { Effect, Layer } from 'effect'
import { fileURLToPath } from 'node:url'

import { Mcp } from '@opencode/core/mcp/index'

export const browserServer = 'ineffa_browser'

// Register before OpenCode takes its initial MCP tool snapshot. Disable this
// default with browser: false when supplying a custom MCP server configuration.
export const browserRuntime = Mcp.node.replace(
  Mcp.node.mapLayer((layer) =>
    Layer.effect(
      Mcp.Service,
      Effect.gen(function* headlessBrowser() {
        const original = yield* Mcp.Service
        const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@playwright/mcp')))
        yield* original.transform((editor) => {
          editor.set(browserServer, {
            type: 'local',
            command: ['node', cli, '--headless', '--browser', 'chromium', '--isolated'],
          })
        })
        return original
      })
    ).pipe(Layer.provide(layer))
  )
)

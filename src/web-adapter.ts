import type { Adapter } from 'ineffa'
import { resolve } from 'node:path'

export function webAdapter(directory: string): Adapter {
  return {
    id: 'web',
    name: '网页',
    platform: 'web',
    agent: 'build',
    directory: resolve(directory),
    identity: { id: 'web-assistant', name: 'Assistant' },
    capabilities: { edit: true, attachments: true, history: false },
    canAccess: (address) => address.kind === 'direct' && address.id.startsWith('web:'),
    async start(context) {
      context.status({ state: 'connected' })
    },
    async stop() {},
    async send(message) {
      return { status: 'sent', messageId: message.id }
    },
    async edit(messageId) {
      return { status: 'sent', messageId }
    },
    mentions: () => [],
    mention: ({ name }) => `@${name}`,
  }
}

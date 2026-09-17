import { kook } from 'ineffa-kook'

import type { AppConfig } from './src/config'

// Optional: a plain TypeScript composition root. WebUI works without this file.
export default {
  directory: 'workspace',
  adapters: process.env.KOOK_BOT_TOKEN
    ? [
        kook({
          id: 'assistant-a',
          name: '助理 A',
          token: process.env.KOOK_BOT_TOKEN,
          agent: 'build',
          // model: 'anthropic/your-model-id',
          directory: 'workspace',
          guilds: [], // Trusted guild IDs allow all channels the Bot can access in those guilds.
          channels: ['REPLACE_WITH_CHANNEL_ID'],
          users: [],
          agentPrompt: {
            identity: '你是 {displayName}，平台账号 ID 为 {platformId}。',
            task: '根据用户请求完成任务，需要协作时通过 mention 联系同一会话中的其他 Agent。',
          },
        }),
      ]
    : [],
  // OpenCode settings are passed through, not translated into another configuration language.
  // opencode: { config: { content: JSON.stringify({ model: "anthropic/your-model-id" }) } },
} satisfies AppConfig

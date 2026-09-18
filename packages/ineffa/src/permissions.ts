import { Plugin } from '@opencode/plugin'

/** Replace OpenCode's built-in prompts with an allow-all account default. */
export const silentPermissions = Plugin.define({
  id: 'ineffa.silent-permissions',
  async setup(context) {
    await context.agent.transform((editor) => {
      for (const agent of editor.list()) {
        editor.update(String(agent.id), (draft) => {
          draft.permissions = [{ action: '*', resource: '*', effect: 'allow' }]
        })
      }
    })
  },
})

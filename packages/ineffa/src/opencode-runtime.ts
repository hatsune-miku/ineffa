import type { OpenCode } from '@opencode/sdk'
import type { OpenCode as EffectOpenCode } from '@opencode/sdk/effect'

// OpenCode 2.0.3's public Promise facade drops embedding options. Keep this single
// version-pinned entry point until it forwards the options supported by its host.
type EmbeddedCreate = (
  options: OpenCode.CreateOptions,
  embed: EffectOpenCode.EmbedOptions
) => Promise<OpenCode.Interface>

export async function createEmbedded(options: OpenCode.CreateOptions, embed: EffectOpenCode.EmbedOptions) {
  const entry = new URL('./promise.js', import.meta.resolve('@opencode/sdk'))
  const runtime = (await import(entry.href)) as { create: EmbeddedCreate }
  return runtime.create(options, embed)
}

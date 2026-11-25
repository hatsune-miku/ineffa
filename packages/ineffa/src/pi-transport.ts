import type { Api, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

import type { PiDebug } from './pi-debug'

/** Retain Pi's native payload, authentication and parsing; observe only this provider's fetch. */
export function piTransport(debug: PiDebug, sessionId: string) {
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    if (model.api !== 'openai-completions') throw new Error(`Pi transport does not support ${model.api}.`)
    return streamSimple(model as Model<'openai-completions'>, context, {
      ...options,
      fetch: debug.wrapFetch(sessionId, options?.fetch),
    })
  }
}

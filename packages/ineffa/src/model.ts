import { IneffaError } from './types'

export function modelReference(value: unknown): { providerID: string; id: string } | undefined {
  if (value === undefined || value === '') return
  if (typeof value !== 'string') throw new IneffaError('invalid_model', '模型标识必须是 provider/model。')

  const model = value.trim()
  if (!model) return
  const separator = model.indexOf('/')
  if (separator < 1 || separator === model.length - 1 || /\s/.test(model))
    throw new IneffaError('invalid_model', '模型标识必须是 provider/model。')

  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) }
}

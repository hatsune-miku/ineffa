import { useState } from 'react'

import { Alert, Button, CheckBox, ComboBox, Field, TextBox } from '@a1knla/cakeui'

import type { FormField, PendingForm } from '../../../../../api'
import { messageOf } from '../../../../../utils'

type Answer = Record<string, string | number | boolean | string[]>

function visible(field: FormField, answer: Answer) {
  return (
    !('when' in field) ||
    !field.when ||
    field.when.every((condition) =>
      condition.op === 'eq' ? answer[condition.key] === condition.value : answer[condition.key] !== condition.value
    )
  )
}

export function FormRequest({
  request,
  respond,
}: {
  request: PendingForm
  respond: (data: object) => Promise<unknown>
}) {
  const [answer, setAnswer] = useState<Answer>(() =>
    Object.fromEntries(
      request.fields.flatMap((f) => ('default' in f && f.default !== undefined ? [[f.key, f.default]] : []))
    )
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function set(key: string, value: Answer[string]) {
    return setAnswer((old) => ({ ...old, [key]: value }))
  }
  async function submit(cancel = false) {
    setBusy(true)
    setError('')
    try {
      await respond({
        id: request.id,
        cancel,
        answer: Object.fromEntries(
          Object.entries(answer).filter(([key]) => request.fields.some((f) => f.key === key && visible(f, answer)))
        ),
      })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="request-panel stack"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div>
        <div className="eyebrow">等待你的回复</div>
        <h3 className="request-title">{request.title}</h3>
      </div>
      {request.fields
        .filter((f) => visible(f, answer))
        .map((field) => {
          const id = `${request.id}-${field.key}`
          if (field.type === 'external')
            return (
              <div key={id}>
                <p>{field.description}</p>
                {/^https?:\/\//.test(field.url) && (
                  <a className="link" href={field.url} target="_blank" rel="noopener noreferrer">
                    {field.title ?? '打开链接'}
                  </a>
                )}
              </div>
            )
          if (field.type === 'boolean')
            return (
              <CheckBox
                key={id}
                checked={Boolean(answer[field.key])}
                onChange={(e) => set(field.key, e.target.checked)}
              >
                {field.title ?? field.key}
              </CheckBox>
            )
          return (
            <Field key={id} label={field.title ?? field.key} htmlFor={id} description={field.description}>
              {field.type === 'multiselect' ? (
                <div className="stack compact">
                  {field.options.map((option) => (
                    <CheckBox
                      key={option.value}
                      checked={((answer[field.key] as string[]) ?? []).includes(option.value)}
                      onChange={(e) =>
                        set(
                          field.key,
                          e.target.checked
                            ? [...((answer[field.key] as string[]) ?? []), option.value]
                            : ((answer[field.key] as string[]) ?? []).filter((v) => v !== option.value)
                        )
                      }
                    >
                      {option.label}
                    </CheckBox>
                  ))}
                </div>
              ) : field.type === 'string' && field.options?.length && !field.custom ? (
                <ComboBox
                  className="form-control"
                  id={id}
                  value={String(answer[field.key] ?? '')}
                  required={field.required}
                  onChange={(e) => set(field.key, e.target.value)}
                >
                  <option value="">请选择</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </ComboBox>
              ) : (
                <TextBox
                  className="form-control"
                  id={id}
                  required={field.required}
                  value={String(answer[field.key] ?? '')}
                  type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                  step={field.type === 'integer' ? 1 : 'any'}
                  onChange={(e) =>
                    set(
                      field.key,
                      field.type === 'number' || field.type === 'integer'
                        ? e.target.value === ''
                          ? ''
                          : Number(e.target.value)
                        : e.target.value
                    )
                  }
                  {...(field.type === 'string'
                    ? {
                        placeholder: field.placeholder,
                        minLength: field.minLength,
                        maxLength: field.maxLength,
                        pattern: field.pattern,
                        list: field.custom && field.options ? `${id}-options` : undefined,
                      }
                    : {
                        min: typeof field.minimum === 'number' ? field.minimum : undefined,
                        max: typeof field.maximum === 'number' ? field.maximum : undefined,
                      })}
                />
              )}
              {field.type === 'string' && field.custom && field.options && (
                <datalist id={`${id}-options`}>
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </datalist>
              )}
            </Field>
          )
        })}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="button-row">
        <Button type="submit" variant="primary" loading={busy}>
          提交回复
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void submit(true)}>
          取消
        </Button>
      </div>
    </form>
  )
}

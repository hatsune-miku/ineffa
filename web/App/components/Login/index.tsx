import { useState } from 'react'

import { Alert, Button, Field, TextBox } from '@a1knla/cakeui'

import { api } from '../../../api'
import { messageOf } from '../../../utils'

import './index.css'

export function Login({ done }: { done: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="login-page">
      <form
        className="login-form stack"
        onSubmit={async (e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          setBusy(true)
          try {
            await api('/login', { token: data.get('token') })
            done()
          } catch (err) {
            setError(messageOf(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <h1 className="login-title">登录 Ineffa</h1>
        <Field label="访问令牌" htmlFor="login-token">
          <TextBox
            className="form-control"
            id="login-token"
            name="token"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" variant="primary" loading={busy}>
          进入
        </Button>
      </form>
    </main>
  )
}

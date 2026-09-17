import { useEffect, useRef, useState } from 'react'

import { Alert, Button } from '@a1knla/cakeui'

import { ImportDialog } from './components/ImportDialog'

import type { MergePreview } from '../../../../../../src/config-transfer'
import { api } from '../../../../../api'
import { messageOf } from '../../../../../utils'

import './index.css'

export function ConfigTransfer() {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [importing, setImporting] = useState<{ archive: unknown; preview: MergePreview } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api<{ pending: boolean }>('/config/status', undefined, controller.signal)
      .then((result) => setPending(result.pending))
      .catch((error) => {
        if (!controller.signal.aborted) setError(messageOf(error))
      })
    return () => controller.abort()
  }, [])

  async function exportConfig() {
    setBusy('export')
    setError('')
    try {
      const archive = await api('/config/export', {})
      const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2) + '\n'], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `ineffa-config-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy('')
    }
  }

  async function readConfig(file: File) {
    setBusy('import')
    setError('')
    try {
      if (file.size > 1024 * 1024) throw new Error('配置文件不能超过 1 MB。')
      let archive: unknown
      try {
        archive = JSON.parse(await file.text())
      } catch {
        throw new Error('文件不是有效的 JSON 配置。')
      }
      const preview = await api<MergePreview>('/config/preview', { archive })
      setImporting({ archive, preview })
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="settings-section config-transfer">
      <div className="section-title">
        <h2 className="section-heading">配置迁移</h2>
        <div className="config-transfer-actions">
          <Button
            size="small"
            disabled={Boolean(busy) || pending}
            loading={busy === 'export'}
            onClick={() => void exportConfig()}
          >
            导出配置
          </Button>
          <Button
            size="small"
            disabled={Boolean(busy) || pending}
            loading={busy === 'import'}
            onClick={() => input.current?.click()}
          >
            导入配置
          </Button>
        </div>
      </div>
      <p className="muted config-transfer-note">明文 JSON，包含模型配置、API Key、平台账号与 Bot Token。</p>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="选择配置文件"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void readConfig(file)
        }}
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {pending && (
        <Alert>
          配置导入已保存，重启服务后生效。
          <Button
            size="small"
            variant="ghost"
            loading={busy === 'cancel'}
            onClick={async () => {
              setBusy('cancel')
              setError('')
              try {
                await api('/config/cancel', {})
                setPending(false)
              } catch (error) {
                setError(messageOf(error))
              } finally {
                setBusy('')
              }
            }}
          >
            撤销导入
          </Button>
        </Alert>
      )}
      {importing && (
        <ImportDialog
          archive={importing.archive}
          preview={importing.preview}
          close={() => setImporting(null)}
          saved={() => {
            setImporting(null)
            setPending(true)
          }}
        />
      )}
    </section>
  )
}

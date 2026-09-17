import { useState } from 'react'

import { Alert, Badge, Button, ComboBox, Dialog, Field, TextBox } from '@a1knla/cakeui'

import type { MergeChoice, MergePreview } from '../../../../../../../../src/config-transfer'
import { ApiError, api } from '../../../../../../../api'
import { messageOf } from '../../../../../../../utils'

import './index.css'

const kindNames = { account: '平台账号', provider: '模型提供方', setting: 'OpenCode 设置', credential: '提供方凭据' }

export function ImportDialog({
  archive,
  preview,
  close,
  saved,
}: {
  archive: unknown
  preview: MergePreview
  close: () => void
  saved: () => void
}) {
  const [choices, setChoices] = useState<MergeChoice[]>(
    preview.items.map((item) => ({
      key: item.key,
      action: item.conflict || item.blocked ? 'keep' : 'import',
      directory: item.directory,
    }))
  )
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const selected = choices.filter((choice) => choice.action === 'import')

  function change(key: string, update: Partial<MergeChoice>) {
    setChoices((values) => values.map((value) => (value.key === key ? { ...value, ...update } : value)))
  }

  async function apply() {
    setBusy(true)
    setError('')
    try {
      await api('/config/import', { archive, revision: preview.revision, choices })
      saved()
    } catch (error) {
      setError(messageOf(error))
      if (error instanceof ApiError && error.code === 'config_changed') setStale(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      title={confirming ? '确认导入' : '合并配置'}
      closeLabel="关闭"
      className="config-import-dialog"
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      footer={
        <>
          <Button disabled={busy} onClick={confirming ? () => setConfirming(false) : close}>
            {confirming ? '上一步' : '取消'}
          </Button>
          <Button
            variant="primary"
            disabled={!selected.length || stale || busy}
            loading={busy}
            onClick={() => (confirming ? void apply() : setConfirming(true))}
          >
            {confirming ? '保存导入' : '下一步'}
          </Button>
        </>
      }
    >
      <div className="config-import-content">
        {error && <Alert tone="danger">{error}</Alert>}
        {confirming ? (
          <>
            <p className="config-import-summary">将导入 {selected.length} 项配置，重启服务后生效。</p>
            <div className="config-import-list">
              {selected.map((choice) => {
                const item = preview.items.find((value) => value.key === choice.key)!
                return (
                  <div className="config-import-summary-row" key={choice.key}>
                    <span>
                      {kindNames[item.kind]} · {item.name}
                    </span>
                    <Badge>{item.conflict ? '合并' : '新增'}</Badge>
                    {item.kind === 'account' && <span className="muted config-import-path">{choice.directory}</span>}
                  </div>
                )
              })}
            </div>
            <p className="muted config-import-note">
              保留本地独有的账号与模型。已选提供方采用导入连接信息，同名模型采用导入值。
            </p>
          </>
        ) : (
          <>
            <p className="muted config-import-note">同 ID 项目默认保留本地配置。文件中的密钥不会在预览中显示。</p>
            <div className="config-import-list">
              {preview.items.map((item, index) => {
                const choice = choices[index]!
                return (
                  <div className="config-import-row" key={item.key}>
                    <div className="config-import-heading">
                      <div className="config-import-label">
                        <strong>{item.name}</strong>
                        <span className="muted">
                          {kindNames[item.kind]} · {item.id}
                        </span>
                      </div>
                      <Badge>
                        {item.blocked ? '只读' : item.identical ? '相同' : item.conflict ? '已存在' : '新增'}
                      </Badge>
                    </div>
                    {item.local && <p className="muted config-import-detail">本地：{item.local}</p>}
                    {item.incoming && <p className="muted config-import-detail">导入：{item.incoming}</p>}
                    {item.blocked ? (
                      <p className="muted config-import-detail">{item.blocked}</p>
                    ) : (
                      <ComboBox
                        className="form-control"
                        aria-label={`${item.name}的合并方式`}
                        value={choice.action}
                        onChange={(event) => change(item.key, { action: event.target.value as MergeChoice['action'] })}
                      >
                        <option value="keep">{item.conflict ? '保留本地' : '跳过'}</option>
                        <option value="import">{item.conflict ? '采用导入配置' : '导入'}</option>
                      </ComboBox>
                    )}
                    {item.kind === 'account' && choice.action === 'import' && (
                      <Field
                        label="目标工作目录"
                        htmlFor={`import-directory-${index}`}
                        description={`原目录：${item.sourceDirectory}`}
                      >
                        <TextBox
                          id={`import-directory-${index}`}
                          className="form-control"
                          value={choice.directory ?? ''}
                          onChange={(event) => change(item.key, { directory: event.target.value })}
                        />
                      </Field>
                    )}
                  </div>
                )
              })}
              {!preview.items.length && <p className="muted">文件中没有可导入的配置。</p>}
            </div>
            {preview.notices.slice(1).map((notice) => (
              <p className="muted config-import-note" key={notice}>
                {notice}
              </p>
            ))}
          </>
        )}
      </div>
    </Dialog>
  )
}

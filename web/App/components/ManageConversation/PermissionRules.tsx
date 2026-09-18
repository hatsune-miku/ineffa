import { useState } from 'react'

import { Button, ComboBox, TextBox } from '@a1knla/cakeui'

import type { ConversationDetail } from '../../../api'

type Rule = ConversationDetail['info']['permissions'][number]

export function PermissionRules({
  initial,
  busy,
  save,
}: {
  initial: Rule[]
  busy: boolean
  save: (rules: Rule[]) => Promise<void>
}) {
  const [rules, setRules] = useState<Rule[]>(initial)
  function update(index: number, value: Partial<Rule>) {
    setRules((items) => items.map((rule, i) => (i === index ? { ...rule, ...value } : rule)))
  }
  return (
    <details className="permission-editor">
      <summary>会话权限 · {rules.length ? `${rules.length} 条规则` : '沿用默认：静默允许'}</summary>
      <div className="stack">
        <ComboBox
          aria-label="权限预设"
          defaultValue=""
          disabled={busy}
          onChange={(event) => {
            const effect = event.target.value
            if (effect === 'inherit') setRules([])
            else if (['allow', 'ask', 'deny'].includes(effect))
              setRules([{ action: '*', resource: '*', effect: effect as Rule['effect'] }])
          }}
        >
          <option value="" disabled>
            选择权限预设
          </option>
          <option value="inherit">沿用默认</option>
          <option value="allow">全部静默允许</option>
          <option value="ask">全部询问</option>
          <option value="deny">全部拒绝</option>
        </ComboBox>
        {rules.map((rule, index) => (
          <div className="permission-rule" key={index}>
            <TextBox
              aria-label={`规则 ${index + 1} 操作`}
              value={rule.action}
              placeholder="操作，如 shell"
              onChange={(event) => update(index, { action: event.target.value })}
            />
            <TextBox
              aria-label={`规则 ${index + 1} 资源`}
              value={rule.resource}
              placeholder="资源，如 *"
              onChange={(event) => update(index, { resource: event.target.value })}
            />
            <ComboBox
              aria-label={`规则 ${index + 1} 结果`}
              value={rule.effect}
              onChange={(event) => update(index, { effect: event.target.value as Rule['effect'] })}
            >
              <option value="allow">允许</option>
              <option value="ask">询问</option>
              <option value="deny">拒绝</option>
            </ComboBox>
            <Button
              size="small"
              variant="ghost"
              aria-label={`删除规则 ${index + 1}`}
              onClick={() => setRules((items) => items.filter((_, i) => i !== index))}
            >
              删除
            </Button>
          </div>
        ))}
        <div className="button-row">
          <Button onClick={() => setRules((items) => [...items, { action: '', resource: '*', effect: 'allow' }])}>
            添加规则
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save(rules)}>
            保存权限
          </Button>
        </div>
        <p className="muted">后面的匹配规则优先。四个工具目录入口始终可用。</p>
      </div>
    </details>
  )
}

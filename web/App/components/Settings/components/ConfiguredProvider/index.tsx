import type { ProviderView } from '../../../../../api'
import { Icon } from '../../../../../components/Icon'
import { IconButton } from '../../../../../components/IconButton'

import './index.css'

export function ConfiguredProvider({
  provider,
  edit,
  remove,
}: {
  provider: ProviderView
  edit: () => void
  remove: (model?: string) => void
}) {
  return (
    <div className="connection-row configured-provider">
      <span className="connection-symbol">
        <Icon name="globe" />
      </span>
      <div className="grow">
        <strong className="connection-name">{provider.name}</strong>
        <span className="muted connection-description">{provider.id}</span>
        <details className="configured-models">
          <summary className="configured-models-summary">{provider.models.length} 个模型</summary>
          <ul className="configured-models-list">
            {provider.models.map((model) => (
              <li className="configured-model" key={model}>
                <span className="configured-model-name">{model}</span>
                <IconButton label={`删除模型 ${model}`} icon="trash" onClick={() => remove(model)} />
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="button-row configured-provider-actions">
        <IconButton label={`编辑 ${provider.name}`} icon="settings" onClick={edit} />
        <IconButton label={`删除提供方 ${provider.name}`} icon="trash" onClick={() => remove()} />
      </div>
    </div>
  )
}

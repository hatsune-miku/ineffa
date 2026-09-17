import { Spinner } from '@a1knla/cakeui'

import './index.css'

export function Loading({ label = '正在载入' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Spinner size="small" />
      <span>{label}</span>
    </div>
  )
}

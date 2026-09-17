import type { ComponentProps } from 'react'

import { Button, HoverTips } from '@a1knla/cakeui'

import { Icon } from '../Icon'

import './index.css'

export function IconButton({
  icon,
  label,
  className = '',
  ...props
}: ComponentProps<typeof Button> & { icon: ComponentProps<typeof Icon>['name']; label: string }) {
  return (
    <HoverTips content={label}>
      <Button variant="ghost" className={`icon-button ${className}`} aria-label={label} {...props}>
        <Icon name={icon} />
      </Button>
    </HoverTips>
  )
}

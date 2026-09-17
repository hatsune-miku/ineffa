import { ComboBox } from '@a1knla/cakeui'

import { IconButton } from '../../../components/IconButton'
import type { AppearanceMode, Palette } from '../../appearance'

import './index.css'

type ThemeControlProps = {
  palette: Palette
  mode: AppearanceMode
  onPaletteChange: (palette: Palette) => void
  onModeChange: (mode: AppearanceMode) => void
}

export function ThemeControl({ palette, mode, onPaletteChange, onModeChange }: ThemeControlProps) {
  return (
    <div className="theme-control">
      <ComboBox
        className="theme-select"
        aria-label="主题配色"
        value={palette}
        onChange={(event) => {
          const value = event.target.value
          onPaletteChange(value === 'pink' || value === 'gold' ? value : 'blue')
        }}
      >
        <option value="blue">蓝色</option>
        <option value="pink">粉色</option>
        <option value="gold">金色</option>
      </ComboBox>
      <IconButton
        label={mode === 'light' ? '切换深色外观' : '切换浅色外观'}
        icon={mode === 'light' ? 'moon' : 'sun'}
        aria-pressed={mode === 'dark'}
        size="small"
        onClick={() => onModeChange(mode === 'light' ? 'dark' : 'light')}
      />
    </div>
  )
}

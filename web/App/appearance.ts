import { useState } from 'react'

export type Palette = 'blue' | 'pink' | 'gold'
export type AppearanceMode = 'light' | 'dark'

function savedPreference(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Appearance changes still work when browser storage is unavailable.
  }
}

export function useAppearance() {
  const [palette, setPalette] = useState<Palette>(() => {
    const saved = savedPreference('ineffa-palette')
    return saved === 'pink' || saved === 'gold' ? saved : 'blue'
  })
  const [mode, setMode] = useState<AppearanceMode>(() =>
    savedPreference('ineffa-theme') === 'dark' ? 'dark' : 'light'
  )

  function changePalette(value: Palette) {
    setPalette(value)
    savePreference('ineffa-palette', value)
  }

  function changeMode(value: AppearanceMode) {
    setMode(value)
    savePreference('ineffa-theme', value)
  }

  return { palette, mode, changePalette, changeMode }
}

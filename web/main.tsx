import { createRoot } from 'react-dom/client'

import '@a1knla/cakeui/style.css'
import '@fontsource-variable/noto-sans-sc'

import { App } from './App'

import './style.css'

createRoot(document.getElementById('root')!).render(<App />)

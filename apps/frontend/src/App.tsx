import { useState } from 'react'
import { useTheme } from './hooks/useTheme'
import { AppShell } from './components/AppShell'
import { NowView } from './components/now/NowView'

export function App() {
  const { theme, toggleTheme } = useTheme()
  const [showAdHoc, setShowAdHoc] = useState(false)

  return (
    <AppShell
      theme={theme}
      onToggleTheme={toggleTheme}
      onAdHoc={() => setShowAdHoc(true)}
    >
      <NowView
        showAdHoc={showAdHoc}
        onAdHocClose={() => setShowAdHoc(false)}
      />
    </AppShell>
  )
}

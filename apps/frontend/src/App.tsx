import { useState } from 'react'
import { useTheme } from './hooks/useTheme'
import { AppShell } from './components/AppShell'
import { NowView } from './components/now/NowView'
import { ListView } from './components/list/ListView'
import { CalendarView } from './components/calendar/CalendarView'
import { SettingsView } from './components/settings/SettingsView'
import type { ViewKey } from './components/ViewNav'

export function App() {
  const { theme, toggleTheme } = useTheme()
  const [showAdHoc, setShowAdHoc] = useState(false)
  const [activeView, setActiveView] = useState<ViewKey>('now')

  return (
    <AppShell
      theme={theme}
      onToggleTheme={toggleTheme}
      onAdHoc={() => setShowAdHoc(true)}
      activeView={activeView}
      onViewChange={setActiveView}
    >
      {activeView === 'now' && (
        <NowView showAdHoc={showAdHoc} onAdHocClose={() => setShowAdHoc(false)} />
      )}
      {activeView === 'list' && <ListView />}
      {activeView === 'calendar' && <CalendarView />}
      {activeView === 'settings' && (
        <SettingsView theme={theme} onToggleTheme={toggleTheme} />
      )}
    </AppShell>
  )
}

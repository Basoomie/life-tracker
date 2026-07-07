import { useState, useEffect } from 'react'
import { useTheme } from './hooks/useTheme'
import { AppShell } from './components/AppShell'
import { NowView } from './components/now/NowView'
import { ListView } from './components/list/ListView'
import { CalendarView } from './components/calendar/CalendarView'
import { SettingsView } from './components/settings/SettingsView'
import { QuickAddModal } from './components/item/QuickAddModal'
import { ItemFormModal } from './components/item/ItemFormModal'
import { api } from './lib/api'
import type { Category, Bucket, Item } from '@tracker/shared'
import type { ViewKey } from './components/ViewNav'

export function App() {
  const { theme, toggleTheme } = useTheme()
  const [activeView, setActiveView] = useState<ViewKey>('now')

  // Shared reference data for item modals
  const [categories, setCategories] = useState<Category[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])

  useEffect(() => {
    api.categories.list().then(setCategories).catch(() => {})
    api.buckets.list().then(setBuckets).catch(() => {})
  }, [])

  // Quick-add modal state
  const [showQuickAdd, setShowQuickAdd] = useState(false)

  // Full-edit modal state: null = hidden, string = edit that item, '' = create new
  const [editItemId, setEditItemId] = useState<string | null>(null)

  function handleOpenFullEdit(itemId: string) {
    setShowQuickAdd(false)
    setEditItemId(itemId)
  }

  function handleSaved(_item: Item) {
    setEditItemId(null)
    // Views poll / refresh on their own cycle; no forced refresh needed here
  }

  return (
    <AppShell
      theme={theme}
      onToggleTheme={toggleTheme}
      onQuickAdd={() => setShowQuickAdd(true)}
      onNewItem={() => setEditItemId('')}
      activeView={activeView}
      onViewChange={setActiveView}
    >
      {activeView === 'now' && (
        <NowView onEditItem={(id) => setEditItemId(id)} />
      )}
      {activeView === 'list' && <ListView onEditItem={(id) => setEditItemId(id)} />}
      {activeView === 'calendar' && <CalendarView onEditItem={(id) => setEditItemId(id)} />}
      {activeView === 'settings' && (
        <SettingsView theme={theme} onToggleTheme={toggleTheme} />
      )}

      {showQuickAdd && (
        <QuickAddModal
          buckets={buckets}
          onClose={() => setShowQuickAdd(false)}
          onOpenFullEdit={handleOpenFullEdit}
        />
      )}

      {editItemId !== null && (
        <ItemFormModal
          itemId={editItemId || null}
          categories={categories}
          buckets={buckets}
          onSaved={handleSaved}
          onClose={() => setEditItemId(null)}
        />
      )}
    </AppShell>
  )
}

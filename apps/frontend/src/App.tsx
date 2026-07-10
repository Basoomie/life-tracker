import { useState, useEffect } from 'react'
import { useTheme } from './hooks/useTheme'
import { AppShell } from './components/AppShell'
import { LoginView } from './components/auth/LoginView'
import { ChangePasswordModal } from './components/auth/ChangePasswordModal'
import { NowView } from './components/now/NowView'
import { ListView } from './components/list/ListView'
import { CalendarView } from './components/calendar/CalendarView'
import { SettingsView } from './components/settings/SettingsView'
import { EvidenceApprovalView } from './components/evidence/EvidenceApprovalView'
import { QuickAddModal } from './components/item/QuickAddModal'
import { ItemFormModal } from './components/item/ItemFormModal'
import { api } from './lib/api'
import type { Category, Bucket, Item, User } from '@tracker/shared'
import type { ViewKey } from './components/ViewNav'

type AuthState = 'checking' | 'authenticated' | 'unauthenticated'

export function App() {
  const { theme, toggleTheme } = useTheme()
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [activeView, setActiveView] = useState<ViewKey>('now')

  // Shared reference data for item modals
  const [categories, setCategories] = useState<Category[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])

  // Quick-add modal state
  const [showQuickAdd, setShowQuickAdd] = useState(false)

  // Full-edit modal state: null = hidden, string = edit that item, '' = create new
  const [editItemId, setEditItemId] = useState<string | null>(null)

  // Change-password modal state
  const [showChangePassword, setShowChangePassword] = useState(false)

  // ── Auth check on mount ───────────────────────────────────────────────────

  useEffect(() => {
    api.auth.me()
      .then((user) => {
        setCurrentUser(user)
        setAuthState('authenticated')
      })
      .catch(() => {
        setAuthState('unauthenticated')
      })
  }, [])

  function handleLogin(user: User) {
    setCurrentUser(user)
    setAuthState('authenticated')
  }

  async function handleLogout() {
    try { await api.auth.logout() } catch { /* ignore — cookie is cleared server-side */ }
    setCurrentUser(null)
    setAuthState('unauthenticated')
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  if (authState === 'checking') {
    return (
      <div className="app-loading" aria-label="Loading…">
        <span className="spinner" aria-hidden="true" />
      </div>
    )
  }

  // ── Login screen ──────────────────────────────────────────────────────────

  if (authState === 'unauthenticated') {
    return <LoginView onLogin={handleLogin} />
  }

  // ── Main app ──────────────────────────────────────────────────────────────

  // Load shared reference data once authenticated
  if (categories.length === 0 && buckets.length === 0) {
    api.categories.list().then(setCategories).catch(() => {})
    api.buckets.list().then(setBuckets).catch(() => {})
  }

  function handleOpenFullEdit(itemId: string) {
    setShowQuickAdd(false)
    setEditItemId(itemId)
  }

  function handleSaved(_item: Item) {
    setEditItemId(null)
  }

  return (
    <>
      <AppShell
        theme={theme}
        onToggleTheme={toggleTheme}
        onQuickAdd={() => setShowQuickAdd(true)}
        onNewItem={() => setEditItemId('')}
        onLogout={handleLogout}
        onChangePassword={() => setShowChangePassword(true)}
        currentUserEmail={currentUser?.email ?? ''}
        activeView={activeView}
        onViewChange={setActiveView}
      >
        {activeView === 'now' && (
          <NowView onEditItem={(id) => setEditItemId(id)} />
        )}
        {activeView === 'list' && <ListView onEditItem={(id) => setEditItemId(id)} />}
        {activeView === 'calendar' && <CalendarView onEditItem={(id) => setEditItemId(id)} />}
        {activeView === 'evidence' && <EvidenceApprovalView />}
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

      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
    </>
  )
}

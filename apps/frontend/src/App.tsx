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
import { StatsView } from './components/stats/StatsView'
import { ReviewsView } from './components/reviews/ReviewsView'
import { QuickAddModal } from './components/item/QuickAddModal'
import { ItemFormModal } from './components/item/ItemFormModal'
import { api } from './lib/api'
import type { Category, Bucket, Item, User } from '@tracker/shared'
import type { ViewKey } from './components/ViewNav'

type AuthState = 'checking' | 'authenticated' | 'unauthenticated'

const ACTIVE_VIEW_STORAGE_KEY = 'tracker-active-view'
const VIEW_KEYS: ViewKey[] = ['now', 'list', 'calendar', 'stats', 'reviews', 'evidence', 'settings']

function getInitialView(): ViewKey {
  const stored = localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY)
  return VIEW_KEYS.includes(stored as ViewKey) ? (stored as ViewKey) : 'now'
}

export function App() {
  const { theme, toggleTheme } = useTheme()
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [activeView, setActiveView] = useState<ViewKey>(getInitialView)

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

  // Load shared reference data once authenticated. Must be a one-shot effect
  // keyed on authState, not a plain call in the render body gated on
  // `categories.length === 0` — a genuinely empty categories/buckets list
  // (e.g. a fresh install with neither configured yet) made that condition
  // true forever, re-firing both fetches on every render in an infinite loop.
  useEffect(() => {
    if (authState !== 'authenticated') return
    api.categories.list().then(setCategories).catch(() => {})
    api.buckets.list().then(setBuckets).catch(() => {})
  }, [authState])

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

  function handleOpenFullEdit(itemId: string) {
    setShowQuickAdd(false)
    setEditItemId(itemId)
  }

  function handleSaved(_item: Item) {
    setEditItemId(null)
  }

  function handleViewChange(view: ViewKey) {
    setActiveView(view)
    localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view)
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
        onViewChange={handleViewChange}
      >
        {activeView === 'now' && (
          <NowView onEditItem={(id) => setEditItemId(id)} />
        )}
        {activeView === 'list' && <ListView onEditItem={(id) => setEditItemId(id)} />}
        {activeView === 'calendar' && <CalendarView onEditItem={(id) => setEditItemId(id)} />}
        {activeView === 'stats' && <StatsView />}
        {activeView === 'reviews' && <ReviewsView />}
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

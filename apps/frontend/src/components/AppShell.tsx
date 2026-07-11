import type { ReactNode } from 'react'
import type { Theme } from '../hooks/useTheme'
import { ViewNav } from './ViewNav'
import type { ViewKey } from './ViewNav'

type Props = {
  theme: Theme
  onToggleTheme: () => void
  onQuickAdd: () => void
  onNewItem: () => void
  onLogout: () => void
  onChangePassword: () => void
  currentUserEmail: string
  activeView: ViewKey
  onViewChange: (v: ViewKey) => void
  children: ReactNode
}

export function AppShell({
  theme, onToggleTheme, onQuickAdd, onNewItem,
  onLogout, onChangePassword, currentUserEmail,
  activeView, onViewChange, children,
}: Props) {
  return (
    <>
      <header className="app-header">
        <h1 className="app-header__wordmark">
          <span className="app-header__dot" aria-hidden="true" />
          Tracker
        </h1>
        <div className="app-header__actions">
          <button
            className="icon-btn"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            data-testid="theme-toggle"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            className="btn btn--ghost"
            onClick={onNewItem}
            aria-label="Add item with full form"
            data-testid="new-item-btn"
          >
            Create Task
          </button>
          <button
            className="btn btn--primary"
            onClick={onQuickAdd}
            aria-label="Quick-add a planned task"
            data-testid="quick-add-btn"
          >
            + Quick
          </button>
          <div className="app-header__user">
            <button
              className="btn btn--ghost btn--sm"
              onClick={onChangePassword}
              aria-label="Change password"
              data-testid="change-password-btn"
            >
              {currentUserEmail}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={onLogout}
              aria-label="Sign out"
              data-testid="logout-btn"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <ViewNav active={activeView} onChange={onViewChange} />
      <main className={`app-main${activeView === 'calendar' ? ' app-main--wide' : ''}`}>
        {children}
      </main>
    </>
  )
}

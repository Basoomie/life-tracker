import type { ReactNode } from 'react'
import type { Theme } from '../hooks/useTheme'
import { ViewNav } from './ViewNav'
import type { ViewKey } from './ViewNav'

type Props = {
  theme: Theme
  onToggleTheme: () => void
  onQuickAdd: () => void
  onNewItem: () => void
  activeView: ViewKey
  onViewChange: (v: ViewKey) => void
  children: ReactNode
}

export function AppShell({ theme, onToggleTheme, onQuickAdd, onNewItem, activeView, onViewChange, children }: Props) {
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
        </div>
      </header>
      <ViewNav active={activeView} onChange={onViewChange} />
      <main className="app-main">
        {children}
      </main>
    </>
  )
}

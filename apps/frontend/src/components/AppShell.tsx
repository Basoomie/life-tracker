import type { ReactNode } from 'react'
import type { Theme } from '../hooks/useTheme'

type Props = {
  theme: Theme
  onToggleTheme: () => void
  onAdHoc: () => void
  children: ReactNode
}

export function AppShell({ theme, onToggleTheme, onAdHoc, children }: Props) {
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
            className="btn btn--primary"
            onClick={onAdHoc}
            aria-label="Start ad-hoc activity"
            data-testid="adhoc-btn"
          >
            + Quick
          </button>
        </div>
      </header>
      <main className="app-main">
        {children}
      </main>
    </>
  )
}

// Theme toggle — backend /api/preferences is the single source of truth.
// A cookie ("tracker-theme") is used as a render hint only: it lets the IIFE
// paint the correct theme immediately before React hydrates, preventing FOUC.
// The cookie is never treated as truth — the backend reconciles on every load.

import { useState, useCallback, useEffect } from 'react'
import { api } from '../lib/api'

export type Theme = 'light' | 'dark'

const COOKIE_NAME = 'tracker-theme'

function getThemeCookie(): Theme | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=(light|dark)`))
  return m ? (m[1] as Theme) : null
}

function setThemeCookie(theme: Theme) {
  document.cookie = `${COOKIE_NAME}=${theme}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
}

function getInitialTheme(): Theme {
  const cookie = getThemeCookie()
  if (cookie) return cookie
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Backend is truth: fetch on mount and reconcile cookie + state to match.
  useEffect(() => {
    api.preferences.get()
      .then((prefs) => {
        const t = prefs['theme'] as Theme | undefined
        if (t === 'light' || t === 'dark') {
          setThemeState(t)
          setThemeCookie(t)
        }
      })
      .catch(() => {/* backend unavailable; cookie hint is sufficient for this session */})
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'light' ? 'dark' : 'light'
      setThemeCookie(next)                              // render hint for next load
      api.preferences.set('theme', next).catch(() => {}) // truth
      return next
    })
  }, [])

  return { theme, toggleTheme }
}

// Apply theme immediately at module load to prevent FOUC.
// Reads the cookie render hint — backend truth is reconciled after React mounts.
;(function bootstrap() {
  applyTheme(getInitialTheme())
})()

// Appearance preferences — surfaces the theme toggle backed by backend preferences.

import type { Theme } from '../../hooks/useTheme'

type Props = {
  theme: Theme
  onToggleTheme: () => void
}

export function PreferencesSection({ theme, onToggleTheme }: Props) {
  return (
    <div className="settings-section" data-testid="preferences-section">
      <div className="settings-section__header">
        <h2 className="settings-section__title">Appearance</h2>
      </div>
      <div className="settings-section__body">
        <div className="pref-row">
          <div>
            <div className="pref-row__label">Theme</div>
            <div className="pref-row__desc">
              {theme === 'dark' ? 'Dark mode active' : 'Light mode active'} — preference saved to your account
            </div>
          </div>
          <div className="pref-row__control">
            <label
              className="now-view__toggle-label"
              data-testid="settings-theme-toggle"
            >
              <span className="toggle">
                <input
                  type="checkbox"
                  className="toggle__input"
                  checked={theme === 'dark'}
                  onChange={onToggleTheme}
                />
                <span className="toggle__track" />
              </span>
              Dark
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

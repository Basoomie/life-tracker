// §13.1 — Login screen. Shown when the user is unauthenticated.
// No registration; credentials are set at bootstrap time.

import { useState, type FormEvent } from 'react'
import { api } from '../../lib/api'
import type { User } from '@tracker/shared'

type Props = {
  onLogin: (user: User) => void
}

export function LoginView({ onLogin }: Props) {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { user } = await api.auth.login(email, password)
      onLogin(user)
    } catch {
      setError('Invalid email or password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-backdrop">
      <div className="login-card">
        <h1 className="login-card__heading">
          <span className="app-header__dot" aria-hidden="true" />
          Tracker
        </h1>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="form-field">
            <label htmlFor="login-email" className="form-label">Email</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              data-testid="login-email"
            />
          </div>

          <div className="form-field">
            <label htmlFor="login-password" className="form-label">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              data-testid="login-password"
            />
          </div>

          {error && (
            <div className="login-error" role="alert" data-testid="login-error">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn--primary login-submit"
            disabled={loading || !email || !password}
            data-testid="login-submit"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

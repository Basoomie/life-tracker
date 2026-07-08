// §13.1 — Change password modal. Reachable from Settings.

import { useState, type FormEvent } from 'react'
import { api } from '../../lib/api'

type Props = {
  onClose: () => void
}

export function ChangePasswordModal({ onClose }: Props) {
  const [current, setCurrent]   = useState('')
  const [next, setNext]         = useState('')
  const [confirm, setConfirm]   = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [success, setSuccess]   = useState(false)
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (next !== confirm) {
      setError('New passwords do not match.')
      return
    }
    if (next.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }

    setLoading(true)
    try {
      await api.auth.changePassword(current, next)
      setSuccess(true)
    } catch {
      setError('Current password is incorrect.')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal__header">
            <h2 className="modal__title">Password changed</h2>
          </div>
          <div className="modal__body">
            <p>Your password has been updated.</p>
          </div>
          <div className="modal__footer">
            <button className="btn btn--primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">Change password</h2>
          <button className="icon-btn modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form className="modal__body" onSubmit={handleSubmit} noValidate>
          <div className="form-field">
            <label htmlFor="cp-current" className="form-label">Current password</label>
            <input
              id="cp-current"
              type="password"
              autoComplete="current-password"
              required
              className="form-input"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="form-field">
            <label htmlFor="cp-new" className="form-label">New password</label>
            <input
              id="cp-new"
              type="password"
              autoComplete="new-password"
              required
              className="form-input"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="form-field">
            <label htmlFor="cp-confirm" className="form-label">Confirm new password</label>
            <input
              id="cp-confirm"
              type="password"
              autoComplete="new-password"
              required
              className="form-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={loading}
            />
          </div>

          {error && (
            <div className="login-error" role="alert">{error}</div>
          )}

          <div className="modal__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={loading || !current || !next || !confirm}
            >
              {loading ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

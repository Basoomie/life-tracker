// §6.7 — Day-start timeline viewer and forward-only append form.
//
// Changes are append-only (never overwrite past values).
// effectiveFrom must be >= today — the backend enforces this and returns
// a clear error if a past date is submitted.
// The UI makes the forward-only constraint visible in the note and the
// date input's min attribute.

import { useState } from 'react'
import type { DayStartEntry } from '@tracker/shared'

type Props = {
  entries: DayStartEntry[]      // ascending order (oldest first)
  onAppend: (value: string, effectiveFrom: string) => Promise<void>
}

export function DayStartSection({ entries, onAppend }: Props) {
  const todayUTC = new Date().toISOString().slice(0, 10)

  const currentEntry = [...entries]
    .filter((e) => e.startsOn <= todayUTC)
    .sort((a, b) => {
      if (b.startsOn !== a.startsOn) return b.startsOn.localeCompare(a.startsOn)
      return String(b.recordedAt).localeCompare(String(a.recordedAt))
    })[0]

  const [newValue, setNewValue] = useState(currentEntry?.value ?? '04:00')
  const [effectiveFrom, setEffectiveFrom] = useState(todayUTC)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const value = newValue.slice(0, 5)
    setBusy(true)
    setError(null)
    setSuccess(false)
    try {
      await onAppend(value, effectiveFrom)
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update day-start')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section" data-testid="day-start-section">
      <div className="settings-section__header">
        <h2 className="settings-section__title">Day Start</h2>
      </div>
      <div className="settings-section__body">

        {/* current effective value */}
        <div className="ds-current">
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-1)' }}>
            Current effective day-start
          </div>
          <span className="ds-current__value" data-testid="day-start-current-value">
            {currentEntry?.value ?? '00:00 (default)'}
          </span>
        </div>

        {/* §6.7 — forward-only note; always visible */}
        <div className="ds-note" data-testid="day-start-past-note">
          Changes apply from the chosen date onward. Past days are not re-bucketed — each
          past day uses the day-start value that was active at the time.
        </div>

        {/* change form */}
        <form className="ds-form" onSubmit={handleSubmit}>
          <div className="ds-form__fields">
            <div className="field">
              <label className="field__label" htmlFor="ds-new-value">New day-start time</label>
              <input
                id="ds-new-value"
                className="field__input"
                type="time"
                value={newValue}
                onChange={(e) => { setNewValue(e.target.value); setSuccess(false) }}
                required
                data-testid="day-start-new-value"
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="ds-effective-from">Effective from</label>
              <input
                id="ds-effective-from"
                className="field__input"
                type="date"
                value={effectiveFrom}
                min={todayUTC}
                onChange={(e) => { setEffectiveFrom(e.target.value); setSuccess(false) }}
                required
                data-testid="day-start-effective-from"
              />
            </div>
          </div>

          {error && (
            <div className="cfg-section-error" role="alert">{error}</div>
          )}
          {success && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-success-fg)', background: 'var(--color-success-subtle)', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)' }}>
              Day-start updated.
            </div>
          )}

          <div>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy}
              data-testid="day-start-submit"
            >
              {busy ? 'Saving…' : 'Apply change'}
            </button>
          </div>
        </form>

        {/* timeline — full history, ascending */}
        {entries.length > 0 && (
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 'var(--space-2)' }}>
              Change history
            </div>
            <div className="ds-timeline" data-testid="day-start-timeline">
              {[...entries].reverse().map((entry, i) => (
                <div
                  key={entry.id}
                  className="ds-timeline__entry"
                  data-testid={`day-start-entry-${entry.id}`}
                >
                  <span className="ds-timeline__date">from {entry.startsOn}</span>
                  <span className="ds-timeline__value">{entry.value}</span>
                  {i === 0 && entry.startsOn <= todayUTC && (
                    <span className="ds-timeline__badge">active</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

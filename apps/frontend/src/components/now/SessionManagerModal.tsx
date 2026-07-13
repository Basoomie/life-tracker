// §9.1 — manage the individual logged-time sessions for one occurrence: add a
// forgotten one, edit a mistimed one, or delete exactly one window without
// touching the others logged the same day (each session is independent).

import { useEffect, useState } from 'react'
import type { OccurrenceWithState, SessionSummary } from '@tracker/shared'
import { api } from '../../lib/api'
import { ConfirmModal } from '../shared/ConfirmModal'

type Props = {
  occ: OccurrenceWithState
  onClose: () => void
  // Called after any add/edit/delete so the caller can refresh the
  // occurrence's loggedMinutes (mirrors the TimerControl display).
  onChanged: () => void
}

type FormState = {
  date: string        // YYYY-MM-DD
  startTime: string    // HH:MM
  endTime: string       // HH:MM
}

function toLocalParts(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

function toIso(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString()
}

function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function nowRoundedToMinute(): Date {
  const d = new Date()
  d.setSeconds(0, 0)
  return d
}

function blankForm(day: string): FormState {
  const end = nowRoundedToMinute()
  const start = new Date(end.getTime() - 20 * 60000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: day,
    startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
  }
}

export function SessionManagerModal({ occ, onClose, onChanged }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 'closed' | 'add' | a sessionId being edited
  const [formTarget, setFormTarget] = useState<'add' | string | null>(null)
  const [form, setForm] = useState<FormState>(() => blankForm(occ.appliesToDay))
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  async function load() {
    if (!occ.id) return
    try {
      const list = await api.occurrences.sessions(occ.id)
      setSessions(list)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load sessions')
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occ.id])

  function openAdd() {
    setForm(blankForm(occ.appliesToDay))
    setFormError(null)
    setFormTarget('add')
  }

  function openEdit(s: SessionSummary) {
    const start = toLocalParts(s.startedAt)
    const end = toLocalParts(s.endedAt)
    setForm({ date: start.date, startTime: start.time, endTime: end.time })
    setFormError(null)
    setFormTarget(s.sessionId)
  }

  async function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    const startedAt = toIso(form.date, form.startTime)
    const endedAt = toIso(form.date, form.endTime)
    if (new Date(endedAt) <= new Date(startedAt)) {
      setFormError('End time must be after start time')
      return
    }

    setBusy(true)
    setFormError(null)
    try {
      if (formTarget === 'add') {
        await api.sessions.manual({ itemId: occ.itemId, day: occ.appliesToDay, startedAt, endedAt })
      } else if (formTarget) {
        await api.sessions.edit(formTarget, { startedAt, endedAt })
      }
      setFormTarget(null)
      await load()
      onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save session')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return
    setDeleteBusy(true)
    try {
      await api.sessions.delete(pendingDelete.sessionId)
      setPendingDelete(null)
      await load()
      onChanged()
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      data-testid="session-manager-modal"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="sm-title">
        <div className="modal__header">
          <h2 className="modal__title" id="sm-title">Time logged — {occ.snapshot.name}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal__body">
          {loadError && <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>{loadError}</p>}

          {sessions === null && !loadError && <p className="session-list__empty">Loading…</p>}

          {sessions !== null && sessions.length === 0 && (
            <p className="session-list__empty" data-testid="session-list-empty">No time logged yet.</p>
          )}

          {sessions !== null && sessions.length > 0 && (
            <ul className="session-list" data-testid="session-list">
              {sessions.map((s) => (
                <li key={s.sessionId} className="session-list__row" data-testid={`session-row-${s.sessionId}`}>
                  <span className="session-list__time">
                    {formatClockTime(s.startedAt)} – {formatClockTime(s.endedAt)}
                  </span>
                  <span className="session-list__duration">{formatDuration(s.durationMin)}</span>
                  <span className={`session-list__badge session-list__badge--${s.source}`}>{s.source}</span>
                  <span className="session-list__actions">
                    <button
                      className="disp-btn"
                      onClick={() => openEdit(s)}
                      aria-label={`Edit session ${formatClockTime(s.startedAt)} to ${formatClockTime(s.endedAt)}`}
                      data-testid={`session-edit-${s.sessionId}`}
                      title="Edit"
                    >
                      ✎
                    </button>
                    <button
                      className="disp-btn disp-btn--danger"
                      onClick={() => setPendingDelete(s)}
                      aria-label={`Delete session ${formatClockTime(s.startedAt)} to ${formatClockTime(s.endedAt)}`}
                      data-testid={`session-delete-${s.sessionId}`}
                      title="Delete"
                    >
                      🗑
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {formTarget === null ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={openAdd}
              data-testid="session-add-btn"
              style={{ marginTop: 'var(--space-3)' }}
            >
              + Add session
            </button>
          ) : (
            <form onSubmit={handleFormSubmit} className="session-form" data-testid="session-form">
              <div className="field">
                <label className="field__label" htmlFor="sm-date">Date</label>
                <input
                  id="sm-date"
                  className="field__input"
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  required
                  data-testid="session-form-date"
                />
              </div>
              <div className="session-form__times">
                <div className="field">
                  <label className="field__label" htmlFor="sm-start">Start</label>
                  <input
                    id="sm-start"
                    className="field__input"
                    type="time"
                    value={form.startTime}
                    onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                    required
                    data-testid="session-form-start"
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="sm-end">End</label>
                  <input
                    id="sm-end"
                    className="field__input"
                    type="time"
                    value={form.endTime}
                    onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                    required
                    data-testid="session-form-end"
                  />
                </div>
              </div>

              {formError && <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>{formError}</p>}

              <div className="session-form__actions">
                <button type="button" className="btn btn--ghost" onClick={() => setFormTarget(null)} disabled={busy}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={busy} data-testid="session-form-submit">
                  {busy ? 'Saving…' : formTarget === 'add' ? 'Add' : 'Save'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {pendingDelete && (
        <ConfirmModal
          title="Delete this session?"
          message={`Remove the ${formatClockTime(pendingDelete.startedAt)}–${formatClockTime(pendingDelete.endedAt)} (${formatDuration(pendingDelete.durationMin)}) entry? Other logged sessions are unaffected.`}
          confirmLabel="Delete"
          busy={deleteBusy}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

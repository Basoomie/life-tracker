// §4c-ii — Quick-add doorway: creates a minimal planned one-time item, no timer.
// Distinct from ad-hoc capture (§9.2), which starts a timer immediately.

import { useState, useEffect, useRef } from 'react'
import type { Bucket, Item, CreateItemBody } from '@tracker/shared'
import { api } from '../../lib/api'

type DayOption = 'today' | 'tomorrow' | 'custom'
type TimeOption = 'none' | 'bucket' | 'point'

type Props = {
  buckets: Bucket[]
  onClose: () => void
  onOpenFullEdit: (itemId: string) => void
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function tomorrowISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function QuickAddModal({ buckets, onClose, onOpenFullEdit }: Props) {
  const [name, setName] = useState('')
  const [dayOption, setDayOption] = useState<DayOption>('today')
  const [customDay, setCustomDay] = useState(todayISO)
  const [timeOption, setTimeOption] = useState<TimeOption>('none')
  const [bucketId, setBucketId] = useState<string>(buckets[0]?.id ?? '')
  const [pointTime, setPointTime] = useState('')
  const [durationMin, setDurationMin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdItem, setCreatedItem] = useState<Item | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { nameRef.current?.focus() }, [])

  function resolveDay(): string {
    if (dayOption === 'today') return todayISO()
    if (dayOption === 'tomorrow') return tomorrowISO()
    return customDay
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const body: CreateItemBody = {
        name: name.trim(),
        creationSource: 'planned',
        day: resolveDay(),
      }
      if (timeOption === 'bucket' && bucketId) {
        body.timingPrecision = 'bucket'
        body.timingBucketId = bucketId
      } else if (timeOption === 'point' && pointTime) {
        body.timingPrecision = 'point'
        body.timingStartTime = pointTime
      }
      const dur = parseInt(durationMin, 10)
      if (!isNaN(dur) && dur > 0) {
        body.plannedDurationMin = dur
      }
      const item = await api.items.create(body)
      setCreatedItem(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
      setBusy(false)
    }
  }

  // ── Success state ──────────────────────────────────────────────────────────
  if (createdItem) {
    return (
      <div
        className="modal-overlay"
        onClick={(e) => e.target === e.currentTarget && onClose()}
        data-testid="quick-add-modal"
      >
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="qa-title">
          <div className="modal__header">
            <h2 className="modal__title" id="qa-title">Task added</h2>
            <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div className="modal__body">
            <p className="qa-success-name" data-testid="qa-created-name">{createdItem.name}</p>
            <p className="adhoc-caption">
              Added to your plan. Use full edit to add recurrence, prerequisites, or nesting.
            </p>
          </div>
          <div className="modal__footer">
            <button className="btn btn--ghost" onClick={onClose} data-testid="qa-done">
              Done
            </button>
            <button
              className="btn btn--primary"
              onClick={() => onOpenFullEdit(createdItem.id)}
              data-testid="qa-open-full-edit"
            >
              Open full edit →
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Form state ─────────────────────────────────────────────────────────────
  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      data-testid="quick-add-modal"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="qa-title">
        <div className="modal__header">
          <h2 className="modal__title" id="qa-title">Quick add</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal__body">
            <p className="adhoc-caption">Plan a task for later — no timer started.</p>

            <div className="field">
              <label className="field__label" htmlFor="qa-name">Task name *</label>
              <input
                id="qa-name"
                ref={nameRef}
                className="field__input"
                type="text"
                placeholder="e.g. Read chapter 5, Gym session…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                data-testid="qa-name"
              />
            </div>

            <div className="field">
              <span className="field__label">Day</span>
              <div className="qa-radio-group">
                {(['today', 'tomorrow', 'custom'] as DayOption[]).map((opt) => (
                  <label
                    key={opt}
                    data-testid={`qa-day-${opt}`}
                    className={`qa-radio${dayOption === opt ? ' qa-radio--active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="qa-day"
                      value={opt}
                      checked={dayOption === opt}
                      onChange={() => setDayOption(opt)}
                      className="sr-only"
                    />
                    {opt === 'today' ? 'Today' : opt === 'tomorrow' ? 'Tomorrow' : 'Pick date'}
                  </label>
                ))}
              </div>
              {dayOption === 'custom' && (
                <input
                  className="field__input"
                  type="date"
                  value={customDay}
                  onChange={(e) => setCustomDay(e.target.value)}
                  data-testid="qa-custom-day"
                  style={{ marginTop: 'var(--space-2)' }}
                />
              )}
            </div>

            <div className="field">
              <span className="field__label">Time (optional)</span>
              <div className="qa-radio-group">
                {(['none', 'bucket', 'point'] as TimeOption[]).map((opt) => (
                  <label
                    key={opt}
                    data-testid={`qa-time-${opt}`}
                    className={`qa-radio${timeOption === opt ? ' qa-radio--active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="qa-time"
                      value={opt}
                      checked={timeOption === opt}
                      onChange={() => setTimeOption(opt)}
                      className="sr-only"
                    />
                    {opt === 'none' ? 'None' : opt === 'bucket' ? 'Bucket' : 'Clock time'}
                  </label>
                ))}
              </div>
              {timeOption === 'bucket' && buckets.length > 0 && (
                <select
                  className="field__select"
                  value={bucketId}
                  onChange={(e) => setBucketId(e.target.value)}
                  data-testid="qa-bucket-select"
                  style={{ marginTop: 'var(--space-2)' }}
                >
                  {buckets.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              )}
              {timeOption === 'point' && (
                <input
                  className="field__input"
                  type="time"
                  value={pointTime}
                  onChange={(e) => setPointTime(e.target.value)}
                  data-testid="qa-point-time"
                  style={{ marginTop: 'var(--space-2)' }}
                />
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="qa-duration">
                Planned duration (min, optional)
              </label>
              <input
                id="qa-duration"
                className="field__input"
                type="number"
                min="1"
                placeholder="e.g. 30"
                value={durationMin}
                onChange={(e) => setDurationMin(e.target.value)}
                data-testid="qa-duration"
              />
            </div>

            {error && (
              <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>
                {error}
              </p>
            )}
          </div>
          <div className="modal__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!name.trim() || busy}
              data-testid="qa-submit"
            >
              {busy ? 'Adding…' : 'Add task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

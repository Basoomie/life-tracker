import { useState } from 'react'
import type { Reason } from '@tracker/shared'

type DispositionType = 'skip' | 'excuse' | 'carry-forward'

type Props = {
  occurrenceName: string
  reasons: Reason[]
  onSkip: (reasonId: string | null, comment: string | null) => Promise<void>
  onExcuse: (reasonId: string | null, comment: string | null) => Promise<void>
  onCarryForward: (targetDay: string, reasonId: string | null, comment: string | null) => Promise<void>
  onClose: () => void
}

export function DispositionModal({
  occurrenceName,
  reasons,
  onSkip,
  onExcuse,
  onCarryForward,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<DispositionType>('skip')
  const [reasonId, setReasonId] = useState('')
  const [comment, setComment] = useState('')
  const [targetDay, setTargetDay] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const rid = reasonId || null
    const cmt = comment.trim() || null
    try {
      if (selected === 'skip')         await onSkip(rid, cmt)
      else if (selected === 'excuse')  await onExcuse(rid, cmt)
      else                             await onCarryForward(targetDay, rid, cmt)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      data-testid="disposition-modal"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="disp-title">
        <div className="modal__header">
          <h2 className="modal__title" id="disp-title">{occurrenceName}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal__body">
            {/* §8 — disposition options */}
            <div className="disp-options">
              <button
                type="button"
                className={`disp-option${selected === 'skip' ? ' disp-option--selected' : ''}`}
                onClick={() => setSelected('skip')}
                data-testid="disp-skip"
              >
                <span className="disp-option__icon">✗</span>
                <div className="disp-option__body">
                  <div className="disp-option__name">Skip</div>
                  <div className="disp-option__desc">Count as a miss; breaks streak</div>
                </div>
              </button>
              <button
                type="button"
                className={`disp-option${selected === 'excuse' ? ' disp-option--selected' : ''}`}
                onClick={() => setSelected('excuse')}
                data-testid="disp-excuse"
              >
                <span className="disp-option__icon">∅</span>
                <div className="disp-option__body">
                  <div className="disp-option__name">Excuse</div>
                  <div className="disp-option__desc">Not counted against streak</div>
                </div>
              </button>
              <button
                type="button"
                className={`disp-option${selected === 'carry-forward' ? ' disp-option--selected' : ''}`}
                onClick={() => setSelected('carry-forward')}
                data-testid="disp-carry"
              >
                <span className="disp-option__icon">→</span>
                <div className="disp-option__body">
                  <div className="disp-option__name">Carry forward</div>
                  <div className="disp-option__desc">Move to another day; original stays</div>
                </div>
              </button>
            </div>

            {selected === 'carry-forward' && (
              <div className="field">
                <label className="field__label" htmlFor="disp-day">Move to</label>
                <input
                  id="disp-day"
                  className="field__input"
                  type="date"
                  value={targetDay}
                  onChange={(e) => setTargetDay(e.target.value)}
                  required
                  data-testid="disp-targetday"
                />
              </div>
            )}

            {reasons.length > 0 && (
              <div className="field">
                <label className="field__label" htmlFor="disp-reason">Reason (optional)</label>
                <select
                  id="disp-reason"
                  className="field__select"
                  value={reasonId}
                  onChange={(e) => setReasonId(e.target.value)}
                  data-testid="disp-reason"
                >
                  <option value="">— none —</option>
                  {reasons.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label className="field__label" htmlFor="disp-comment">Comment (optional)</label>
              <textarea
                id="disp-comment"
                className="field__textarea"
                placeholder="Any context…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                data-testid="disp-comment"
              />
            </div>

            {error && <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>{error}</p>}
          </div>
          <div className="modal__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy}
              data-testid="disp-submit"
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

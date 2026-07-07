import { useState, useEffect, useRef } from 'react'
import type { Category } from '@tracker/shared'
import type { Valence } from '@tracker/shared'

type Props = {
  categories: Category[]
  onCapture: (name: string, categoryId: string | null, valence: Valence | null) => Promise<void>
  onClose: () => void
}

export function AdHocModal({ categories, onCapture, onClose }: Props) {
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState<string>('')
  const [valence, setValence] = useState<Valence | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onCapture(
        name.trim(),
        categoryId || null,
        (valence as Valence) || null
      )
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture')
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      data-testid="adhoc-modal"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="adhoc-title">
        <div className="modal__header">
          <h2 className="modal__title" id="adhoc-title">Quick capture</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal__body">
            <p className="adhoc-caption">Name the activity — timer starts immediately.</p>
            <div className="field">
              <label className="field__label" htmlFor="adhoc-name">Activity</label>
              <input
                id="adhoc-name"
                ref={nameRef}
                className="field__input"
                type="text"
                placeholder="e.g. Reading, Spanish podcast…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                data-testid="adhoc-name"
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="adhoc-cat">Category (optional)</label>
              <select
                id="adhoc-cat"
                className="field__select"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                data-testid="adhoc-category"
              >
                <option value="">— unclassified —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="adhoc-valence">Valence (optional)</label>
              <select
                id="adhoc-valence"
                className="field__select"
                value={valence}
                onChange={(e) => setValence(e.target.value as Valence | '')}
                data-testid="adhoc-valence"
              >
                <option value="">— unset —</option>
                <option value="productive">Productive</option>
                <option value="neutral">Neutral</option>
                <option value="unproductive">Unproductive</option>
              </select>
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
              disabled={!name.trim() || busy}
              data-testid="adhoc-submit"
            >
              {busy ? 'Starting…' : '▶ Start timer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// §6.6 — Bucket boundary editor with visual tiling strip.
//
// Tiling validation runs server-side (validateBucketTiling in domain/buckets.ts).
// On a PATCH /buckets/:id/boundaries the API returns either the updated bucket
// or a 400 { error: 'invalid_tiling', message: '...' }.  The UI surfaces any
// tiling error clearly and keeps the form open — it never silently accepts or
// silently fixes an invalid edit.

import { useState } from 'react'
import type { Bucket } from '@tracker/shared'

// ── Band strip helpers ─────────────────────────────────────────────────────────

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

type BandInfo = {
  bucket: Bucket
  startPct: number
  widthPct: number
  colorIdx: number
}

function computeBands(buckets: Bucket[], dayStart: string): BandInfo[] {
  if (buckets.length === 0) return []
  const dayStartMin = hhmmToMinutes(dayStart)

  const parsed = buckets.map((b) => {
    const startRaw = (hhmmToMinutes(b.startTime) - dayStartMin + 1440) % 1440
    const endRaw   = (hhmmToMinutes(b.endTime)   - dayStartMin + 1440) % 1440
    return { bucket: b, startOffset: startRaw, endOffset: endRaw === 0 ? 1440 : endRaw }
  })

  parsed.sort((a, b) => a.startOffset - b.startOffset)

  return parsed.map((p, idx) => ({
    bucket: p.bucket,
    startPct: (p.startOffset / 1440) * 100,
    widthPct: ((p.endOffset - p.startOffset) / 1440) * 100,
    colorIdx: idx % 4,
  }))
}

// ── Component ──────────────────────────────────────────────────────────────────

type Props = {
  buckets: Bucket[]
  dayStart: string        // HH:MM effective value (from day-start timeline)
  onUpdateBoundaries: (id: string, startTime: string, endTime: string) => Promise<void>
}

export function BucketSection({ buckets, dayStart, onUpdateBoundaries }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)

  const bands = computeBands(buckets, dayStart)

  function openEdit(bucket: Bucket) {
    setEditingId(bucket.id)
    setEditStart(bucket.startTime)
    setEditEnd(bucket.endTime)
    setEditError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditError(null)
  }

  async function handleSave() {
    if (!editingId) return
    // Normalise time inputs — some browsers return 'HH:MM:SS'
    const start = editStart.slice(0, 5)
    const end   = editEnd.slice(0, 5)
    setEditBusy(true)
    setEditError(null)
    try {
      await onUpdateBoundaries(editingId, start, end)
      setEditingId(null)
    } catch (err) {
      // Surface the server's tiling error message directly (§6.6)
      setEditError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setEditBusy(false)
    }
  }

  const btnSm: React.CSSProperties = {
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--text-xs)',
  }

  return (
    <div className="settings-section" data-testid="bucket-section">
      <div className="settings-section__header">
        <h2 className="settings-section__title">Buckets</h2>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>
          Day starts at {dayStart}
        </span>
      </div>
      <div className="settings-section__body">

        {/* §6.6 — visual tiling strip */}
        <div className="bucket-strip" data-testid="bucket-strip" aria-label="Bucket tiling strip">
          {bands.length === 0 ? (
            <span className="bucket-strip__empty">No buckets configured</span>
          ) : (
            bands.map((band) => (
              <div
                key={band.bucket.id}
                className={`bucket-strip__band bucket-strip__band--${band.colorIdx}`}
                style={{ left: `${band.startPct}%`, width: `${band.widthPct}%` }}
                title={`${band.bucket.name}: ${band.bucket.startTime}–${band.bucket.endTime}`}
                data-testid={`bucket-band-${band.bucket.id}`}
              >
                {band.widthPct > 8 ? band.bucket.name : ''}
              </div>
            ))
          )}
        </div>

        {/* bucket list with per-row edit */}
        {buckets.length === 0 ? (
          <p className="cfg-empty">No buckets defined yet.</p>
        ) : (
          <div className="cfg-list">
            {buckets.map((bucket) => (
              <div key={bucket.id}>
                <div className="bucket-row" data-testid={`bucket-row-${bucket.id}`}>
                  <span className="bucket-row__name">{bucket.name}</span>
                  <span className="bucket-row__times">
                    {bucket.startTime} → {bucket.endTime}
                  </span>
                  <button
                    className="btn btn--ghost"
                    style={btnSm}
                    onClick={() => editingId === bucket.id ? cancelEdit() : openEdit(bucket)}
                    data-testid={`bucket-row-${bucket.id}-edit-btn`}
                  >
                    {editingId === bucket.id ? 'Cancel' : 'Edit'}
                  </button>
                </div>

                {editingId === bucket.id && (
                  <div className="bucket-edit-form" data-testid="bucket-edit-form">
                    <div className="bucket-edit-fields">
                      <div className="field">
                        <label className="field__label" htmlFor="bucket-edit-start">Start time</label>
                        <input
                          id="bucket-edit-start"
                          className="field__input"
                          type="time"
                          value={editStart}
                          onChange={(e) => setEditStart(e.target.value)}
                          data-testid="bucket-edit-start"
                        />
                      </div>
                      <div className="field">
                        <label className="field__label" htmlFor="bucket-edit-end">End time</label>
                        <input
                          id="bucket-edit-end"
                          className="field__input"
                          type="time"
                          value={editEnd}
                          onChange={(e) => setEditEnd(e.target.value)}
                          data-testid="bucket-edit-end"
                        />
                      </div>
                    </div>

                    {/* §6.6 — tiling error surfaced clearly; form stays open */}
                    {editError && (
                      <div className="cfg-section-error" role="alert" data-testid="bucket-edit-error">
                        {editError}
                      </div>
                    )}

                    <div className="bucket-edit-actions">
                      <button
                        className="btn btn--primary"
                        style={btnSm}
                        onClick={handleSave}
                        disabled={editBusy}
                        data-testid="bucket-edit-save"
                      >
                        {editBusy ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        className="btn btn--ghost"
                        style={btnSm}
                        onClick={cancelEdit}
                        data-testid="bucket-edit-cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

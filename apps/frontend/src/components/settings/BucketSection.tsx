// §6.6 — Bucket editor. The editable unit is the **seam** between two buckets, not a
// bucket's own start/end: "Early Morning ends at 09:00" and "Morning starts at 09:00"
// are one fact, and moving one side without the other is exactly what opens a gap.
// Each seam row here moves both neighbours in a single API call.
//
// The day-boundary seam is shown but locked — it moves with the day-start (§6.7), in
// the section below. When the set has drifted out of anchor, that seam is an ordinary
// editable one and the banner says so: moving it back is the repair.
//
// Validation is server-authoritative (PATCH /buckets/:id/seam). The same rules run here
// from @tracker/shared purely to render the warning and to keep the form open on error.

import { useState } from 'react'
import {
  buildBucketCycle,
  offsetFromDayStart,
  spanMinutes,
  validateBucketTiling,
} from '@tracker/shared'
import type { Bucket, BucketSeam } from '@tracker/shared'

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

type BandInfo = {
  bucket: Bucket
  startPct: number
  widthPct: number
  colorIdx: number
}

function computeBands(ordered: Bucket[], dayStart: string): BandInfo[] {
  return ordered.map((bucket, idx) => ({
    bucket,
    startPct: (offsetFromDayStart(bucket.startTime, dayStart) / 1440) * 100,
    widthPct: (spanMinutes(bucket.startTime, bucket.endTime) / 1440) * 100,
    colorIdx: idx % 4,
  }))
}

// ── Component ──────────────────────────────────────────────────────────────────

type Props = {
  buckets: Bucket[]
  dayStart: string        // HH:MM effective value (from day-start timeline)
  onMoveSeam: (beforeBucketId: string, time: string) => Promise<void>
}

export function BucketSection({ buckets, dayStart, onMoveSeam }: Props) {
  const [editingSeamId, setEditingSeamId] = useState<string | null>(null)
  const [editTime, setEditTime] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)

  const cycleResult = buildBucketCycle(buckets, dayStart)
  const cycle = cycleResult.ok ? cycleResult.cycle : null
  const tilingError = validateBucketTiling(buckets, dayStart)

  const ordered = cycle ? cycle.ordered : buckets
  const bands = cycle ? computeBands(cycle.ordered, dayStart) : []

  // Seam that ends bucket i, keyed by the bucket it follows.
  const seamAfter = new Map<string, BucketSeam>()
  for (const seam of cycle?.seams ?? []) seamAfter.set(seam.beforeBucketId, seam)

  function openEdit(seam: BucketSeam) {
    setEditingSeamId(seam.beforeBucketId)
    setEditTime(seam.time)
    setEditError(null)
  }

  function cancelEdit() {
    setEditingSeamId(null)
    setEditError(null)
  }

  async function handleSave(seam: BucketSeam) {
    // Normalise time inputs — some browsers return 'HH:MM:SS'
    const time = editTime.slice(0, 5)
    setEditBusy(true)
    setEditError(null)
    try {
      await onMoveSeam(seam.beforeBucketId, time)
      setEditingSeamId(null)
    } catch (err) {
      // Surface the server's message directly (§6.6)
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

        {/* §6.6 — the set no longer tiles the day. Always a fact about the data, never
            a guess: the message is the same rule the API enforces. */}
        {tilingError && (
          <div className="bucket-warning" role="alert" data-testid="bucket-tiling-warning">
            <strong>Buckets don&rsquo;t cover the whole day.</strong> {tilingError}
            {cycle && !cycle.anchored && (
              <>
                {' '}Move the {cycle.seams[cycle.seams.length - 1].time} seam to {dayStart},
                or re-apply the day-start below to move it for you.
              </>
            )}
          </div>
        )}

        {/* §6.6 — visual tiling strip */}
        <div className="bucket-strip" data-testid="bucket-strip" aria-label="Bucket tiling strip">
          {bands.length === 0 ? (
            <span className="bucket-strip__empty">
              {buckets.length === 0 ? 'No buckets configured' : 'Buckets do not tile the day'}
            </span>
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

        {/* Buckets in day-start order, with the editable seam between each pair */}
        {buckets.length === 0 ? (
          <p className="cfg-empty">No buckets defined yet.</p>
        ) : (
          <div className="cfg-list">
            {ordered.map((bucket) => {
              const seam = seamAfter.get(bucket.id)
              const isEditing = seam != null && editingSeamId === seam.beforeBucketId

              return (
                <div key={bucket.id}>
                  <div className="bucket-row" data-testid={`bucket-row-${bucket.id}`}>
                    <span className="bucket-row__name">{bucket.name}</span>
                    <span className="bucket-row__times">
                      {bucket.startTime} → {bucket.endTime}
                    </span>
                    <span className="bucket-row__duration">
                      {formatDuration(spanMinutes(bucket.startTime, bucket.endTime))}
                    </span>
                  </div>

                  {seam && (
                    <div className="bucket-seam" data-testid={`bucket-seam-${seam.beforeBucketId}`}>
                      <span className="bucket-seam__time">{seam.time}</span>
                      {seam.isDayBoundary ? (
                        <span className="bucket-seam__label" data-testid="bucket-seam-day-boundary">
                          day boundary — moves with the day-start below
                        </span>
                      ) : (
                        <>
                          <span className="bucket-seam__label">
                            {seam.beforeName} → {seam.afterName}
                          </span>
                          <button
                            className="btn btn--ghost"
                            style={btnSm}
                            onClick={() => (isEditing ? cancelEdit() : openEdit(seam))}
                            data-testid={`bucket-seam-${seam.beforeBucketId}-edit-btn`}
                          >
                            {isEditing ? 'Cancel' : 'Edit'}
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {seam && isEditing && (
                    <div className="bucket-edit-form" data-testid="bucket-seam-form">
                      <div className="bucket-edit-fields">
                        <div className="field">
                          <label className="field__label" htmlFor="bucket-seam-time">
                            {seam.beforeName} ends / {seam.afterName} starts
                          </label>
                          <input
                            id="bucket-seam-time"
                            className="field__input"
                            type="time"
                            value={editTime}
                            onChange={(e) => setEditTime(e.target.value)}
                            data-testid="bucket-seam-time"
                          />
                        </div>
                      </div>

                      {/* §6.6 — server's error surfaced clearly; form stays open */}
                      {editError && (
                        <div className="cfg-section-error" role="alert" data-testid="bucket-seam-error">
                          {editError}
                        </div>
                      )}

                      <div className="bucket-edit-actions">
                        <button
                          className="btn btn--primary"
                          style={btnSm}
                          onClick={() => handleSave(seam)}
                          disabled={editBusy}
                          data-testid="bucket-seam-save"
                        >
                          {editBusy ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          className="btn btn--ghost"
                          style={btnSm}
                          onClick={cancelEdit}
                          data-testid="bucket-seam-cancel"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
